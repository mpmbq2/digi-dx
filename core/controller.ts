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

import { DaemonClient } from "./daemon-client.js";
import type { EngineKind } from "./protocol.js";
import { SlotClock } from "./slot-clock.js";
import type {
  AutomationTx,
  DecodeRecord,
  QsoLogEntry,
  QsoRecord,
  TxSlot
} from "./qso.js";

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
  now?: () => number; // injectable wall clock (test hook); defaults to Date.now
  onLog?: (level: LogLevel, text: string) => void; // activity-log sink
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
    catPort: string;
  }): void;
  releaseControl(): void;

  start(): void; // subscribe to client events, seed worked-calls/dial-freq
  dispose(): void; // clear timers, unsubscribe
}
