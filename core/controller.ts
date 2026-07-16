// OperatorController — the headless QSO automation engine (rebuild plan W2).
//
// This owns everything both reference clients used to orchestrate independently:
// the QsoAutomation, the decode buffer, the slot-aligned scheduler, the survey,
// control-claim state, dial frequency, and the worked-call/logging side effects.
// The web server and the TUI become thin: they render `ControllerState` and route
// input to the operator-action methods. All dependencies are injected, so the
// engine runs identically inside a client process today or inside the daemon
// later (rebuild plan option B) — a relocation, not a rewrite.
//
// U1 scaffolds the interface, state shape, deps, and change emitter. U2 ports the
// web server's orchestration into the method bodies.

import type { DaemonClient } from "./daemon-client.js";
import type {
  AudioDevicesMessage,
  ConfigMessage,
  DaemonCommand,
  DaemonStatus,
  DecodeEvent,
  EngineKind,
  ErrorMessage,
  LogEvent,
  TxEvent,
  TxUpdateEvent
} from "./protocol.js";
import { SlotClock } from "./slot-clock.js";
import {
  QsoAutomation,
  oppositeSlot,
  slotFromTimestamp,
  suggestClearAf,
  type AutomationTx,
  type DecodeRecord,
  type QsoAutomationEvent,
  type QsoLogEntry,
  type QsoRecord,
  type TxSlot
} from "./qso.js";
import { gridFrom, latestSlotAfs, senderOf } from "./view-model.js";

// The daemon's public TX state, re-exported so clients need not reach into the
// daemon protocol for it.
export type TxState = "idle" | "pending" | "active";

export type LogLevel = "info" | "warn" | "error" | "tx" | "qso";

export interface SetupDeviceView {
  id: number;
  name: string;
  defaultSampleRate: number | null;
}

// Persisted, engine-scoped QSO log. Wraps the on-disk JSONL writer/reader so the
// controller never imports a client-side path helper directly (KTD3).
export interface QsoLogStore {
  append(entry: QsoLogEntry, engine: EngineKind): Promise<void>;
  readAll(): Promise<QsoLogEntry[]>;
}

// Small persisted-state seam for the dial frequency (today's tui-state.json).
export interface StateStore {
  read(): Promise<{ dialFreqHz?: number | null }>;
  write(patch: { dialFreqHz?: number | null }): Promise<void>;
}

export interface OperatorControllerDeps {
  client: DaemonClient;
  log: QsoLogStore;
  state?: StateStore;
  token?: string;
  onLog?: (level: LogLevel, text: string) => void; // activity-log sink
  // Optional ham-band namer for the dial-frequency log line. Injected (rather
  // than imported) so the engine keeps zero ui/ dependencies.
  bandForMHz?: (mhz: number) => string | null;
}

// The authoritative, framework-agnostic snapshot both clients render from. It
// mirrors exactly what the web server's buildState() reads today, so the
// view-model becomes a pure ControllerState -> StateMessage transform (KTD2).
export interface ControllerState {
  station: {
    call: string;
    grid: string;
    dialFreqHz: number | null;
    catConnected: boolean;
    sessionActive: boolean;
    controlHeld: boolean;
    controlMine: boolean;
    demo: boolean; // engineKind === "simulated"
  };
  setup: {
    complete: boolean;
    missing: string[];
    devices: SetupDeviceView[];
  };
  tx: {
    state: TxState;
    enabled: boolean;
    // The automation TX to surface: pending ?? active ?? scheduled.
    displayTx: AutomationTx | null;
    txingQsoId: string | null;
  };
  survey: {
    active: boolean;
    slot: TxSlot | null;
    endSec: number;
  };
  af: {
    value: number;
    slot: TxSlot; // the slot we will transmit in (CQ row's slot, else manual)
  };
  qsos: {
    callingCq: boolean;
    active: QsoRecord[];
    completed: QsoRecord[];
  };
  decodes: DecodeRecord[];
  workedCalls: ReadonlySet<string>;
  // The daemon's published slot clock, or null before the first status / after a
  // disconnect. Clients derive countdowns and cycle math from it; they never
  // invent slot timing from a local wall clock.
  clock: SlotClock | null;
}

export type QsoActionName =
  | "complete"
  | "abandon"
  | "resume"
  | "retry"
  | "prevStep"
  | "nextStep"
  | "moveUp"
  | "moveDown";

export interface OperatorController {
  readonly state: ControllerState;
  onChange(listener: (state: ControllerState) => void): () => void;

  // Operator actions — mirror today's UI handlers.
  setIdentity(call: string, grid: string): void;
  setDialFreq(mhz: number | null): void;
  setAf(af: number): void;
  setSlot(slot: TxSlot): void;
  callCq(slot?: TxSlot, identity?: { myCall?: string; myGrid?: string }): void;
  stopCq(reason?: string): void;
  replyToCall(call: string, identity?: { myCall?: string; myGrid?: string }): void;
  qsoAction(id: string, action: QsoActionName): void;
  survey(): void;
  setTxEnabled(enabled: boolean): void;
  haltTx(): void;
  startSession(): void;
  startDemo(): void;
  stopSession(): void;
  saveSetup(setup: {
    deviceId: number;
    callsign: string;
    grid: string;
    catMode: string;
    catPort: number;
  }): void;
  releaseControl(): void;

  start(): void; // subscribe to client events, seed worked-calls/dial-freq
  dispose(): void; // clear timers, unsubscribe
}

// Slot survey: hold TX for one receive cycle of our TX parity so the (otherwise
// deaf) TX slot can be observed, then suggest a clear frequency.
const SURVEY_LO_HZ = 300;
const SURVEY_HI_HZ = 2700;
const SURVEY_DECODE_LAG_SECONDS = 5;
// Arm this many virtual seconds before the slot opens, so the daemon has time to
// hand the message to the engine. Virtual, so it scales with the clock.
const AUTOMATION_LEAD_SECONDS = 2;

export function createOperatorController(deps: OperatorControllerDeps): OperatorController {
  return new OperatorControllerImpl(deps);
}

class OperatorControllerImpl implements OperatorController {
  private readonly client: DaemonClient;
  private readonly logStore: QsoLogStore;
  private readonly stateStore?: StateStore;
  private readonly token?: string;
  private readonly onLog?: (level: LogLevel, text: string) => void;
  private readonly bandForMHz?: (mhz: number) => string | null;

  private readonly decodes: DecodeRecord[] = [];
  // The automation is constructed before any clock arrives, so its timestamp
  // source is a late-bound closure over the clock we adopt from the daemon. It
  // throws rather than reaching for Date.now(): this is the one place that
  // decides every logged QSO's timestamp, and a silent wall-time fallback would
  // log a scaled QSO in the wrong time base. Safe because the daemon sends a
  // status on connect, before any decode can arrive.
  private readonly automation = new QsoAutomation(() => new Date(this.requireClock().now()));

  private myCall = "";
  private myGrid = "";
  private dialFreqHz: number | null = null;

  private controlHeld = false;
  private controlMine = false;
  private controlClaimPending = false;
  private sessionActive = false;
  private catConnected = false;
  private configComplete = false;
  private configMissing: string[] = [];
  private setupDevices: SetupDeviceView[] = [];

  private latestTxState: TxState = "idle";
  private pendingAutomationTx: AutomationTx | null = null;
  private activeAutomationTx: AutomationTx | null = null;
  private scheduledAutomationTx: AutomationTx | null = null;
  // The daemon is the authority on slot timing. We hold the clock it publishes
  // and derive every slot decision from it. There is deliberately no wall-clock
  // fallback: before the first status, and after a reconnect, we have no clock,
  // and a silent Date.now() fallback is exactly the bug a scaled clock would hide.
  private clock: SlotClock | null = null;
  private engineKind: EngineKind = "ft8cat";

  private automationTimer: ReturnType<typeof setTimeout> | null = null;
  private txEnabled = true;

  private currentAf = 1000;
  private currentSlot: TxSlot = "even";

  private readonly loggedQsoIds = new Set<string>();
  private readonly workedCalls = new Set<string>();

  private surveyActive = false;
  private surveySlot: TxSlot | null = null;
  private surveyEndSec = 0;
  private surveyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: OperatorControllerDeps) {
    this.client = deps.client;
    this.logStore = deps.log;
    this.stateStore = deps.state;
    this.token = deps.token;
    this.onLog = deps.onLog;
    this.bandForMHz = deps.bandForMHz;
  }

  // --- state + change emission --------------------------------------------

  get state(): ControllerState {
    const txingQsoId =
      this.pendingAutomationTx?.qsoId ?? this.activeAutomationTx?.qsoId ?? null;
    const displayTx =
      this.pendingAutomationTx ?? this.activeAutomationTx ?? this.scheduledAutomationTx;
    return {
      station: {
        call: this.myCall,
        grid: this.myGrid,
        dialFreqHz: this.dialFreqHz,
        catConnected: this.catConnected,
        sessionActive: this.sessionActive,
        controlHeld: this.controlHeld,
        controlMine: this.controlMine,
        demo: this.engineKind === "simulated"
      },
      setup: {
        complete: this.configComplete,
        missing: this.configMissing,
        devices: this.setupDevices
      },
      tx: {
        state: this.latestTxState,
        enabled: this.txEnabled,
        displayTx,
        txingQsoId
      },
      survey: {
        active: this.surveyActive,
        slot: this.surveySlot,
        endSec: this.surveyEndSec
      },
      af: { value: this.currentAf, slot: this.currentTxSlot() },
      qsos: {
        callingCq: this.automation.isCallingCq(),
        active: this.automation.qsos.filter((qso) => qso.status !== "complete"),
        completed: this.automation.qsos.filter((qso) => qso.status === "complete")
      },
      decodes: this.decodes,
      workedCalls: this.workedCalls,
      clock: this.clock
    };
  }

  onChange(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.state;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private appendLog(level: LogLevel, text: string): void {
    this.onLog?.(level, text);
    this.emit();
  }

  private requireClock(): SlotClock {
    if (!this.clock) {
      throw new Error("slot clock unavailable: no status received from the daemon yet");
    }
    return this.clock;
  }

  private daemonSend(command: DaemonCommand): boolean {
    if (!this.client.send(command)) {
      this.appendLog("warn", "daemon not connected");
      return false;
    }
    return true;
  }

  // --- lifecycle -----------------------------------------------------------

  start(): void {
    void this.seedPersistedState();
    this.subscribe();
    this.client.connect();
  }

  dispose(): void {
    this.clearAutomationTimer();
    if (this.surveyTimer) {
      clearTimeout(this.surveyTimer);
      this.surveyTimer = null;
    }
    for (const off of this.unsubscribers.splice(0)) {
      off();
    }
    this.listeners.clear();
  }

  private async seedPersistedState(): Promise<void> {
    if (this.stateStore) {
      try {
        const persisted = await this.stateStore.read();
        if (persisted.dialFreqHz != null) {
          this.dialFreqHz = persisted.dialFreqHz;
          this.emit();
        }
      } catch {
        // Non-fatal: start without a restored dial frequency.
      }
    }
    try {
      for (const entry of await this.logStore.readAll()) {
        if (entry.theirCall) {
          this.workedCalls.add(entry.theirCall.toUpperCase());
        }
      }
    } catch {
      // Non-fatal: start with an empty worked-call set.
    }
  }

  private subscribe(): void {
    type AnyHandler = (...args: never[]) => void;
    // The typed EventEmitter's per-event overloads don't resolve through a
    // generic helper, so erase to a plain (event, handler) shape here; each
    // handler is written with its concrete payload type below.
    const emitterOn = this.client.on.bind(this.client) as unknown as (e: string, h: AnyHandler) => void;
    const emitterOff = this.client.off.bind(this.client) as unknown as (e: string, h: AnyHandler) => void;
    const add = (event: string, handler: AnyHandler): void => {
      emitterOn(event, handler);
      this.unsubscribers.push(() => emitterOff(event, handler));
    };

    add("open", (() => {
      this.appendLog("info", "connected to daemon");
      this.daemonSend({ type: "get_config" });
      this.daemonSend({ type: "list_audio_devices" });
    }) as AnyHandler);
    add("close", (() => this.onDaemonClose()) as AnyHandler);
    add("status", ((msg: DaemonStatus) => this.onStatus(msg)) as AnyHandler);
    add("decode", ((msg: DecodeEvent) => this.onDecode(msg)) as AnyHandler);
    add("tx", ((msg: TxEvent) => this.onTx(msg)) as AnyHandler);
    add("tx_update", ((msg: TxUpdateEvent) => this.updateTxState(msg.state)) as AnyHandler);
    add("log", ((msg: LogEvent) => this.appendLog(msg.level, `[daemon] ${msg.message}`)) as AnyHandler);
    add("daemonError", ((msg: ErrorMessage) => this.onDaemonError(msg)) as AnyHandler);
    add("config", ((msg: ConfigMessage) => this.onConfig(msg)) as AnyHandler);
    add("audio_devices", ((msg: AudioDevicesMessage) => this.onAudioDevices(msg)) as AnyHandler);
  }

  // --- daemon events -------------------------------------------------------

  private onDaemonClose(): void {
    this.controlHeld = false;
    this.controlMine = false;
    this.controlClaimPending = false;
    this.sessionActive = false;
    this.latestTxState = "idle";
    // Drop the daemon's clock on disconnect: there is no authoritative time base
    // until the next status arrives. Leaving a scaled clock (or an armed timer)
    // across reconnect is exactly the demo->real footgun.
    this.clock = null;
    this.engineKind = "ft8cat";
    this.clearAutomationState("daemon disconnected");
    this.appendLog("warn", "daemon connection closed; retrying in 2s");
  }

  private onStatus(msg: DaemonStatus): void {
    const { session, tx, control } = msg;
    const hadControl = this.controlMine;
    const previousActive = this.sessionActive;
    const previousKind = this.engineKind;
    const previousClock = this.clock;

    // Adopt the daemon's clock. Any field change (not just scale) can move the
    // next boundary, so re-arm rather than leaving a timer at a stale anchor.
    const clockDirty =
      previousClock === null ||
      previousClock.spec.epochMs !== msg.clock.epochMs ||
      previousClock.spec.anchorWallMs !== msg.clock.anchorWallMs ||
      previousClock.spec.slotMs !== msg.clock.slotMs ||
      previousClock.spec.scale !== msg.clock.scale;
    this.clock = new SlotClock(msg.clock);
    this.engineKind = msg.engine;

    if (session.callsign !== null) {
      this.myCall = session.callsign;
    }
    if (session.grid !== null) {
      this.myGrid = session.grid;
    }
    this.controlHeld = control.held;
    this.controlMine = control.byThisClient;
    if (this.controlMine || !this.controlHeld) {
      this.controlClaimPending = false;
    }
    this.sessionActive = session.active;
    this.catConnected = session.catConnected;

    const sessionEnded = previousActive && !session.active;
    const kindChanged = previousKind !== msg.engine;
    // Demo->real at scale 1 never trips a scale-only dirty check. Clear in-flight
    // QSOs so leftover QQ0DEMO CQs cannot key the live radio or land in the real
    // QSO log when they complete under the new engine.
    if (sessionEnded || kindChanged) {
      this.clearAutomationState(sessionEnded ? "session stopped" : "engine changed");
    } else if (clockDirty) {
      this.clearAutomationTimer();
    }

    this.updateTxState(tx.state);

    if (
      this.sessionActive &&
      ((!hadControl && this.controlMine) || clockDirty || (kindChanged && !sessionEnded))
    ) {
      this.scheduleAutomation();
    }
    this.emit();
  }

  private onDecode(msg: DecodeEvent): void {
    const record: DecodeRecord = {
      ts: msg.ts,
      snr: msg.snr,
      dt: msg.dt,
      af: msg.af,
      message: msg.message
    };
    this.decodes.push(record);
    if (this.decodes.length > 2000) {
      this.decodes.splice(0, this.decodes.length - 2000);
    }
    const events = this.automation.handleDecode(record, this.myCall, this.myGrid);
    if (events.length > 0) {
      this.handleQsoEvents(events);
      this.cancelSurvey("answering caller");
      this.scheduleAutomation();
    }
    this.emit();
  }

  private onTx(msg: TxEvent): void {
    this.appendLog("tx", `[tx] af=${msg.af} ${msg.message}`);
    const result = this.automation.confirmTransmission(this.pendingAutomationTx, {
      ts: msg.ts,
      af: msg.af,
      message: msg.message
    });
    if (result.matched) {
      this.activeAutomationTx = this.pendingAutomationTx;
      this.pendingAutomationTx = null;
    }
    if (result.events.length > 0) {
      this.handleQsoEvents(result.events);
    }
    this.scheduleAutomation();
  }

  private onDaemonError(msg: ErrorMessage): void {
    if (msg.code === "CONTROL_REQUIRED" || msg.code === "CONTROL_UNAVAILABLE") {
      this.controlClaimPending = false;
      this.appendLog("warn", "control is held by another client");
    } else {
      this.appendLog("error", `[error] ${msg.code}: ${msg.message}`);
    }
    if (this.pendingAutomationTx) {
      this.pendingAutomationTx = null;
      this.activeAutomationTx = null;
      this.scheduledAutomationTx = null;
      this.scheduleAutomation();
    }
  }

  private onConfig(msg: ConfigMessage): void {
    this.configComplete = msg.complete;
    this.configMissing = msg.missing ?? [];
    if (msg.session?.callsign) {
      this.myCall = msg.session.callsign;
    }
    if (msg.session?.grid) {
      this.myGrid = msg.session.grid;
    }
    this.appendLog("info", `[config] complete=${msg.complete}`);
    this.emit();
  }

  private onAudioDevices(msg: AudioDevicesMessage): void {
    this.setupDevices = msg.devices.map((device) => ({
      id: device.id,
      name: device.name,
      defaultSampleRate: device.defaultSampleRate ?? null
    }));
    this.emit();
  }

  // --- QSO event handling / logging ---------------------------------------

  private handleQsoEvents(events: QsoAutomationEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "qso_created":
          this.appendLog("qso", `[qso] created ${event.qso.theirCall ?? "CQ"}`);
          break;
        case "qso_updated":
          this.appendLog("qso", `[qso] ${event.qso.theirCall} ${event.previousStep} -> ${event.qso.step}`);
          break;
        case "qso_completed":
          this.appendLog("qso", `[qso] complete ${event.qso.theirCall ?? "CQ"} (${event.reason})`);
          void this.logCompletedQso(event.qso, event.reason);
          break;
        case "qso_timed_out":
          this.appendLog("qso", `[qso] timed out ${event.qso.theirCall ?? "CQ"} step=${event.qso.step}`);
          break;
        case "cq_stopped":
          this.appendLog("qso", "[qso] CQ stopped after reply");
          break;
      }
    }
    this.emit();
  }

  private async logCompletedQso(qso: QsoRecord, reason: string): Promise<void> {
    if (this.loggedQsoIds.has(qso.id)) {
      return;
    }
    const entry = this.automation.toLogEntry(qso, reason, this.dialFreqHz);
    if (!entry) {
      return;
    }
    this.loggedQsoIds.add(qso.id);
    try {
      await this.logStore.append(entry, this.engineKind);
      this.workedCalls.add(entry.theirCall.toUpperCase());
      this.appendLog("info", `[qso-log] wrote ${entry.theirCall}${this.dialFreqHz ? "" : " (no freq set)"}`);
    } catch (error) {
      this.loggedQsoIds.delete(qso.id);
      this.appendLog("error", `[qso-log error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- scheduler -----------------------------------------------------------

  // The slot we transmit in: the active CQ row's slot, else the manual slot.
  private currentTxSlot(): TxSlot {
    const cq = this.automation.qsos.find(
      (qso) => qso.kind === "calling-cq" && qso.status === "active"
    );
    return cq ? cq.nextSlot : this.currentSlot;
  }

  private currentAfOrNull(): number | null {
    if (!Number.isInteger(this.currentAf) || this.currentAf < 200 || this.currentAf > 3000) {
      return null;
    }
    return this.currentAf;
  }

  private clearAutomationTimer(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer);
      this.automationTimer = null;
    }
    this.scheduledAutomationTx = null;
  }

  private clearAutomationState(_reason: string): void {
    this.clearAutomationTimer();
    if (this.surveyActive) {
      this.cancelSurvey("session boundary");
    }
    this.automation.qsos.splice(0);
    this.pendingAutomationTx = null;
    this.activeAutomationTx = null;
    this.scheduledAutomationTx = null;
  }

  // Re-arm automation on the falling edge of "active" (a transmission finished),
  // or on a genuine "idle" (e.g. after cancel). The daemon rests in "pending"
  // after a TX, so we never rely on seeing "idle" to resume.
  private updateTxState(next: TxState): void {
    const wasActive = this.latestTxState === "active";
    this.latestTxState = next;
    if (wasActive && next !== "active") {
      this.activeAutomationTx = null;
    }
    if (this.surveyActive || next === "active") {
      return;
    }
    if (wasActive || next === "idle") {
      this.scheduleAutomation();
    }
  }

  private scheduleAutomation(): void {
    this.clearAutomationTimer();

    if (!this.sessionActive || this.surveyActive || !this.txEnabled || this.latestTxState === "active") {
      this.emit();
      return;
    }

    const af = this.currentAfOrNull();
    if (af === null) {
      this.emit();
      return;
    }

    const tx = this.automation.nextTransmission(af);
    if (!tx) {
      this.emit();
      return;
    }

    this.scheduledAutomationTx = tx;
    if (!this.ensureAutomationControl()) {
      this.emit();
      return;
    }

    if (!this.clock) {
      this.appendLog("warn", "[automation] paused: awaiting the slot clock from the daemon");
      this.emit();
      return;
    }

    // Arm two virtual seconds before the slot opens. The lead is a virtual
    // quantity, so it scales with everything else; the clock converts it to the
    // wall delay this setTimeout actually needs.
    const delayMs = this.clock.wallDelayUntilSlot(tx.intent.slot, AUTOMATION_LEAD_SECONDS);
    this.automationTimer = setTimeout(() => this.sendAutomatedTx(tx), delayMs);
    this.emit();
  }

  private sendAutomatedTx(tx: AutomationTx): void {
    this.automationTimer = null;
    this.scheduledAutomationTx = null;
    if (!this.sessionActive || this.surveyActive || !this.txEnabled || this.latestTxState === "active") {
      return;
    }
    const af = this.currentAfOrNull();
    if (af === null) {
      this.appendLog("warn", "automation paused: invalid AF");
      return;
    }
    if (!this.ensureAutomationControl()) {
      this.scheduledAutomationTx = tx;
      this.emit();
      return;
    }
    const refreshed: AutomationTx = { ...tx, intent: { ...tx.intent, af } };
    this.pendingAutomationTx = refreshed;
    this.daemonSend({ type: "transmit", ...refreshed.intent });
    this.emit();
  }

  // --- slot survey ---------------------------------------------------------

  private startSurvey(): void {
    if (this.surveyActive) {
      return;
    }
    const slot = this.currentTxSlot();
    this.surveyActive = true;
    this.surveySlot = slot;

    this.clearAutomationTimer();
    if (this.pendingAutomationTx) {
      this.daemonSend({ type: "cancel_transmit" });
      this.pendingAutomationTx = null;
    }
    this.activeAutomationTx = null;
    this.scheduledAutomationTx = null;

    if (!this.clock) {
      this.appendLog("warn", "[survey] unavailable: awaiting the slot clock from the daemon");
      this.surveyActive = false;
      this.emit();
      return;
    }

    // Hold TX for one whole slot past the boundary, plus decode latency. That is
    // a negative offset -- we wait past the slot rather than arming before it --
    // and the slot length comes from the clock, never a literal 15.
    const slotSeconds = this.clock.spec.slotMs / 1000;
    const pastBoundary = slotSeconds + SURVEY_DECODE_LAG_SECONDS;
    const delaySec = this.clock.secondsUntilSlot(slot) + pastBoundary;
    // surveyEndSec is a rendered deadline, not a delay, so it lives in the
    // clock's virtual base -- the same base the countdown is compared against.
    this.surveyEndSec = this.clock.virtualDeadlineAfter(delaySec);
    this.appendLog("info", `[survey] holding TX ~${delaySec}s to listen on the ${slot} slot`);
    if (this.surveyTimer) {
      clearTimeout(this.surveyTimer);
    }
    this.surveyTimer = setTimeout(() => this.finishSurvey(), this.clock.wallDelayUntilSlot(slot, -pastBoundary));
    this.emit();
  }

  private finishSurvey(): void {
    this.surveyTimer = null;
    const slot = this.surveySlot;
    this.surveyActive = false;
    this.surveySlot = null;
    if (slot) {
      const occupied = latestSlotAfs(this.decodes, slot);
      const suggestion = suggestClearAf(occupied, SURVEY_LO_HZ, SURVEY_HI_HZ);
      this.currentAf = suggestion;
      this.appendLog("info", `[survey] ${slot} slot updated, clear@${suggestion}Hz (${occupied.length} sigs)`);
    }
    this.scheduleAutomation();
  }

  private cancelSurvey(reason: string): void {
    if (!this.surveyActive) {
      return;
    }
    if (this.surveyTimer) {
      clearTimeout(this.surveyTimer);
      this.surveyTimer = null;
    }
    this.surveyActive = false;
    this.surveySlot = null;
    this.appendLog("info", `[survey] aborted (${reason})`);
  }

  // --- control -------------------------------------------------------------

  private ensureControl(): boolean {
    if (this.controlMine) {
      return true;
    }
    if (this.controlHeld) {
      this.appendLog("warn", "you do not have control (another client holds it)");
      return false;
    }
    return this.daemonSend({ type: "claim_control", ...(this.token ? { token: this.token } : {}) });
  }

  private ensureAutomationControl(): boolean {
    if (this.controlMine) {
      return true;
    }
    if (this.controlHeld) {
      this.appendLog("warn", "automation paused: another client has control");
      return false;
    }
    if (
      !this.controlClaimPending &&
      this.daemonSend({ type: "claim_control", ...(this.token ? { token: this.token } : {}) })
    ) {
      this.controlClaimPending = true;
      this.appendLog("info", "[control] claiming daemon control for automation");
    }
    return false;
  }

  private ensureIdentity(): boolean {
    if (!this.myCall || !this.myGrid) {
      this.appendLog("warn", "automation requires a callsign and grid");
      return false;
    }
    if (!this.clock) {
      this.appendLog("warn", "automation paused: awaiting the slot clock from the daemon");
      return false;
    }
    return true;
  }

  private applyOptionalIdentity(identity?: { myCall?: string; myGrid?: string }): void {
    if (identity && typeof identity.myCall === "string" && typeof identity.myGrid === "string") {
      const nextCall = identity.myCall.trim().toUpperCase();
      const nextGrid = identity.myGrid.trim().toUpperCase();
      if (nextCall || nextGrid) {
        this.myCall = nextCall;
        this.myGrid = nextGrid;
      }
    }
  }

  private findLastDecodeFrom(call: string): DecodeRecord | null {
    for (let index = this.decodes.length - 1; index >= 0; index--) {
      if (senderOf(this.decodes[index]!.message) === call) {
        return this.decodes[index]!;
      }
    }
    return null;
  }

  // --- operator actions ----------------------------------------------------

  setIdentity(call: string, grid: string): void {
    this.myCall = call.trim().toUpperCase();
    this.myGrid = grid.trim().toUpperCase();
    this.appendLog("info", `[identity] ${this.myCall} ${this.myGrid}`);
    this.emit();
  }

  setDialFreq(mhz: number | null): void {
    if (mhz === null) {
      this.dialFreqHz = null;
    } else if (!Number.isFinite(mhz) || mhz <= 0) {
      this.appendLog("warn", "freq: enter a positive frequency in MHz (e.g. 14.074)");
      return;
    } else {
      this.dialFreqHz = Math.round(mhz * 1e6);
      const band = this.bandForMHz?.(mhz) ?? null;
      this.appendLog("info", `[freq] dial = ${mhz.toFixed(3)} MHz${band ? ` (${band})` : " (out of ham band?)"}`);
    }
    void this.stateStore
      ?.write({ dialFreqHz: this.dialFreqHz })
      .catch((error) =>
        this.appendLog("error", `[state error] ${error instanceof Error ? error.message : String(error)}`)
      );
    this.emit();
  }

  setAf(af: number): void {
    if (Number.isInteger(af)) {
      this.currentAf = af;
      this.scheduleAutomation();
    }
  }

  setSlot(slot: TxSlot): void {
    this.currentSlot = slot;
    const cq = this.automation.qsos.find(
      (qso) => qso.kind === "calling-cq" && qso.status === "active"
    );
    if (cq) {
      cq.nextSlot = slot;
      cq.updatedAt = new Date().toISOString();
    }
    this.scheduleAutomation();
  }

  callCq(slot?: TxSlot, identity?: { myCall?: string; myGrid?: string }): void {
    this.applyOptionalIdentity(identity);
    if (!this.ensureIdentity()) {
      return;
    }
    if (this.automation.isCallingCq()) {
      this.stopCq("operator stopped CQ");
      return;
    }
    if (slot) {
      this.currentSlot = slot;
    }
    this.automation.createCq(this.myCall, this.myGrid, slot ?? this.currentSlot, "top");
    this.appendLog("qso", "[qso] calling CQ");
    this.scheduleAutomation();
  }

  stopCq(reason = "operator stopped CQ"): void {
    const cq = this.automation.qsos.find(
      (qso) => qso.kind === "calling-cq" && qso.status === "active"
    );
    if (!cq) {
      return;
    }

    const shouldCancelDaemonTx =
      this.pendingAutomationTx?.qsoId === cq.id || this.activeAutomationTx?.qsoId === cq.id;

    this.automation.abandon(cq.id);
    if (this.scheduledAutomationTx?.qsoId === cq.id) {
      this.clearAutomationTimer();
    }
    if (this.pendingAutomationTx?.qsoId === cq.id) {
      this.pendingAutomationTx = null;
    }
    if (this.activeAutomationTx?.qsoId === cq.id) {
      this.activeAutomationTx = null;
    }
    if (shouldCancelDaemonTx) {
      this.daemonSend({ type: "cancel_transmit" });
    }
    this.appendLog("qso", `[qso] ${reason}`);
    this.scheduleAutomation();
  }

  replyToCall(rawCall: string, identity?: { myCall?: string; myGrid?: string }): void {
    this.applyOptionalIdentity(identity);
    if (!this.ensureIdentity()) {
      return;
    }
    const call = rawCall.trim().toUpperCase();
    if (!/^[A-Z0-9/]{2,}$/.test(call)) {
      this.appendLog("warn", `'${call}' is not a valid callsign`);
      return;
    }
    const existing = this.automation.qsos.find(
      (qso) => qso.kind === "standard" && qso.theirCall === call && qso.status !== "complete"
    );
    if (existing) {
      this.appendLog("info", `QSO already exists for ${call}`);
      return;
    }
    const last = this.findLastDecodeFrom(call);
    const nextSlot = last ? oppositeSlot(slotFromTimestamp(last.ts)) : this.currentSlot;
    const theirGrid = last ? gridFrom(last.message) : null;
    const qso = this.automation.createReplyToCall(call, this.myCall, this.myGrid, nextSlot, theirGrid, "top");
    this.appendLog("qso", `[qso] reply to ${qso.theirCall}`);
    this.scheduleAutomation();
  }

  qsoAction(id: string, action: QsoActionName): void {
    switch (action) {
      case "complete":
        this.handleQsoEvents(this.automation.complete(id));
        break;
      case "abandon":
        this.automation.abandon(id);
        break;
      case "resume":
        this.automation.resume(id);
        break;
      case "retry":
        this.automation.resetAttempts(id);
        break;
      case "prevStep":
        this.automation.previousStep(id);
        break;
      case "nextStep":
        this.automation.nextStep(id);
        break;
      case "moveUp":
        this.automation.move(id, -1);
        break;
      case "moveDown":
        this.automation.move(id, 1);
        break;
      default:
        this.appendLog("warn", `unknown qso action '${String(action)}'`);
        return;
    }
    this.scheduleAutomation();
  }

  survey(): void {
    this.startSurvey();
  }

  setTxEnabled(enabled: boolean): void {
    this.txEnabled = enabled;
    if (!enabled) {
      this.clearAutomationTimer();
      this.appendLog("info", "[tx] disabled — current transmission will finish");
    } else {
      // Resuming re-activates anything paused by a prior halt.
      for (const qso of this.automation.qsos) {
        if (qso.status === "paused") {
          this.automation.resume(qso.id);
        }
      }
      this.appendLog("info", "[tx] enabled");
      this.scheduleAutomation();
    }
    this.emit();
  }

  haltTx(): void {
    this.daemonSend({ type: "cancel_transmit" });
    this.cancelSurvey("halted");
    this.pendingAutomationTx = null;
    this.activeAutomationTx = null;
    this.scheduledAutomationTx = null;
    this.clearAutomationTimer();
    this.txEnabled = false;
    this.automation.pauseAll("halted");
    this.appendLog("warn", "[tx] halted by operator");
    this.emit();
  }

  startSession(): void {
    if (!this.ensureControl()) {
      return;
    }
    if (!this.configComplete) {
      this.appendLog("warn", "complete station setup before starting a session");
      this.emit();
      return;
    }
    this.daemonSend({ type: "start_session" });
  }

  startDemo(): void {
    if (!this.ensureControl()) {
      return;
    }
    // No configComplete guard: the whole point is that a user with no radio has
    // no config to satisfy it with. The daemon synthesizes a demo identity.
    this.appendLog("info", "[demo] starting on the simulated engine — nothing is transmitted");
    this.daemonSend({ type: "start_session", demo: true });
  }

  stopSession(): void {
    if (!this.ensureControl()) {
      return;
    }
    this.daemonSend({ type: "stop_session" });
  }

  saveSetup(setup: {
    deviceId: number;
    callsign: string;
    grid: string;
    catMode: string;
    catPort: number;
  }): void {
    if (!this.ensureControl()) {
      return;
    }
    if (this.sessionActive) {
      this.appendLog("warn", "cannot save setup while a session is active");
      return;
    }
    this.daemonSend({
      type: "save_config",
      session: {
        mode: "FT8",
        device: { id: setup.deviceId },
        callsign: setup.callsign,
        grid: setup.grid,
        cat: { mode: setup.catMode, port: setup.catPort }
      }
    });
  }

  releaseControl(): void {
    if (!this.controlMine) {
      this.appendLog("warn", "control is not held by this client");
      return;
    }
    this.daemonSend({ type: "release_control" });
  }
}
