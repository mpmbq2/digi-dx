import { EventEmitter } from "node:events";
import { SlotClock } from "../../core/slot-clock.js";
import type { SessionConfig } from "./config.js";
import {
  driverDecodeToEvent,
  driverTxToEvent,
  type DriverDecode,
  type DriverTx,
  type EngineDriver
} from "./engine-driver.js";
import type {
  BroadcastEvent,
  DaemonStatus,
  EngineKind,
  SlotClockSpec,
  TxIntent,
  TxStatus
} from "./protocol.js";
import { DaemonError } from "./protocol.js";
import { TxState } from "./tx-state.js";

type EngineState = "inactive" | "starting" | "active" | "stopping";

export interface EngineSnapshot {
  state: EngineState;
  session: SessionConfig | null;
  catConnected: boolean;
  freq: number | null;
  ptt: boolean;
  tx: TxStatus;
  engine: EngineKind;
  clock: SlotClockSpec;
}

export interface EngineEvents {
  status: [];
  event: [BroadcastEvent];
  error: [DaemonError];
}

export interface EngineOptions {
  driver: EngineDriver;
  // The engine behind demo mode. Selection happens per session, not per process:
  // an environment variable read at boot cannot serve a user who already
  // launched digi-dx normally and then clicks "try it without a radio".
  simulatedDriver?: EngineDriver;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface EngineApi extends EventEmitter<EngineEvents> {
  snapshot(): EngineSnapshot;
  start(session: SessionConfig, kind?: EngineKind): Promise<void>;
  stop(): Promise<void>;
  transmit(intent: TxIntent): Promise<void>;
  cancelTransmit(): Promise<void>;
  listAudioDevices(kind?: EngineKind): ReturnType<EngineDriver["listAudioDevices"]>;
}

export class Engine extends EventEmitter<EngineEvents> implements EngineApi {
  private state: EngineState = "inactive";
  private session: SessionConfig | null = null;
  private catConnected = false;
  private freq: number | null = null;
  private ptt = false;
  private txState: TxState;
  private clock: SlotClock;
  private driver: EngineDriver;
  private bound: EngineDriver | null = null;
  private readonly drivers: Record<EngineKind, EngineDriver>;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  // Held as fields so they can be unbound again: a driver outlives the session
  // that selected it, and a demo session must not leave listeners on the real
  // driver (or vice versa) once it stops.
  private readonly handlers = {
    decode: (decode: DriverDecode) => this.emit("event", driverDecodeToEvent(decode)),
    tx: (tx: DriverTx) => this.emit("event", driverTxToEvent(tx)),
    freq: (freq: number) => {
      this.freq = freq;
      this.emit("status");
    },
    ptt: (active: boolean) => {
      this.txState.markEngineTx(active);
      this.ptt = active;
      this.emit("status");
    },
    crash: () => {
      void this.handleCrash();
    }
  };

  constructor(options: EngineOptions) {
    super();
    this.drivers = {
      ft8cat: options.driver,
      simulated: options.simulatedDriver ?? options.driver
    };
    this.driver = options.driver;
    this.logger = options.logger ?? console;
    this.clock = new SlotClock(this.driver.clock());
    this.txState = this.createTxState();
  }

  snapshot(): EngineSnapshot {
    return {
      state: this.state,
      session: this.session,
      catConnected: this.catConnected,
      freq: this.freq,
      ptt: this.ptt,
      tx: this.txState.snapshot(),
      engine: this.driver.kind,
      clock: this.clock.spec
    };
  }

  async start(session: SessionConfig, kind: EngineKind = "ft8cat"): Promise<void> {
    if (this.state !== "inactive") {
      return;
    }

    // Select the driver for this session, and bind only its events.
    this.driver = this.drivers[kind];
    this.bindDriverEvents();

    this.state = "starting";
    this.session = session;
    this.emit("status");

    try {
      await this.driver.start(session);
      // Re-read the clock: a driver may only anchor its time base once started.
      // The TxState closure reads this field, so reassigning re-bases it too.
      this.clock = new SlotClock(this.driver.clock());
      this.state = "active";
      this.catConnected = true;
      this.emit("event", { type: "log", level: "info", message: `Session started on device ${session.device.id}` });
      this.emit("status");
    } catch (error) {
      this.resetLocalState();
      try {
        await this.driver.stop();
      } catch {
        // Driver may have failed before spawning.
      }
      this.unbindDriverEvents();
      this.state = "inactive";
      this.session = null;
      this.emit("status");
      if (error instanceof DaemonError) {
        throw error;
      }
      throw new DaemonError("ENGINE_START_FAILED", "failed to start engine", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async stop(): Promise<void> {
    if (this.state === "inactive") {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }

    this.state = "stopping";
    this.emit("status");
    await this.driver.stop();
    this.unbindDriverEvents();
    this.resetLocalState();
    this.state = "inactive";
    this.session = null;
    this.emit("event", { type: "log", level: "info", message: "Session stopped" });
    this.emit("status");
  }

  async transmit(intent: TxIntent): Promise<void> {
    if (this.state !== "active") {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }
    await this.txState.transmit(intent);
    this.emit("status");
  }

  async cancelTransmit(): Promise<void> {
    if (this.state !== "active") {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }
    await this.txState.cancel();
    this.ptt = false;
    this.emit("status");
  }

  // Defaults to the currently selected driver, but the first-run setup surface
  // needs the simulated driver's fabricated device before any session exists --
  // otherwise a radio-less user has nothing to show and nothing to pick.
  async listAudioDevices(kind?: EngineKind): ReturnType<EngineDriver["listAudioDevices"]> {
    return (kind ? this.drivers[kind] : this.driver).listAudioDevices();
  }

  private createTxState(): TxState {
    const txState = new TxState({
      transmit: (intent) => this.driver.transmit(intent),
      cancelTransmit: () => this.driver.cancelTransmit(),
      // TxStateOptions.now is in unix SECONDS (tx_update.ts matches
      // DecodeEvent.ts on the wire), while SlotClock.now() is virtual
      // MILLISECONDS. Passing the clock straight through would multiply every
      // tx_update timestamp by a thousand, silently, on the wire.
      now: () => Math.floor(this.clock.now() / 1000)
    });
    txState.on("txUpdate", (event) => this.emit("event", event));
    return txState;
  }

  private bindDriverEvents(): void {
    if (this.bound === this.driver) {
      return;
    }
    this.unbindDriverEvents();
    this.driver.on("decode", this.handlers.decode);
    this.driver.on("tx", this.handlers.tx);
    this.driver.on("freq", this.handlers.freq);
    this.driver.on("ptt", this.handlers.ptt);
    this.driver.on("crash", this.handlers.crash);
    this.bound = this.driver;
  }

  private unbindDriverEvents(): void {
    if (!this.bound) {
      return;
    }
    this.bound.off("decode", this.handlers.decode);
    this.bound.off("tx", this.handlers.tx);
    this.bound.off("freq", this.handlers.freq);
    this.bound.off("ptt", this.handlers.ptt);
    this.bound.off("crash", this.handlers.crash);
    this.bound = null;
  }

  private async handleCrash(): Promise<void> {
    this.resetLocalState();
    try {
      await this.driver.stop();
    } catch {
      // Driver already exited.
    }
    this.unbindDriverEvents();
    this.state = "inactive";
    this.session = null;
    const error = new DaemonError("PROCESS_CRASHED", "the engine exited unexpectedly");
    this.emit("error", error);
    this.emit("status");
  }

  private resetLocalState(): void {
    this.catConnected = false;
    this.freq = null;
    this.ptt = false;
    this.txState.clear();
  }
}

export function statusFromSnapshot(snapshot: EngineSnapshot, control: DaemonStatus["control"], id?: string | number): DaemonStatus {
  const session = snapshot.session;
  return {
    ...(id === undefined ? {} : { id }),
    type: "status",
    engine: snapshot.engine,
    clock: snapshot.clock,
    session: {
      active: snapshot.state !== "inactive",
      mode: session?.mode ?? null,
      device: session?.device ?? null,
      catConnected: snapshot.catConnected,
      freq: snapshot.freq,
      ptt: snapshot.ptt,
      callsign: session?.callsign ?? null,
      grid: session?.grid ?? null
    },
    tx: snapshot.tx,
    control
  };
}
