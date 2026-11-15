import { EventEmitter } from "node:events";
import type {
  CommandId,
  DaemonCommand,
  DaemonStatus,
  DecodeEvent,
  ErrorMessage,
  LogEvent,
  ServerMessage,
  SlotClockSpec,
  TxEvent,
  TxIntent,
  TxSlot,
  TxStatus,
  TxUpdateEvent
} from "../protocol.js";
import { SlotClock } from "../slot-clock.js";
import type { TransportAdapter } from "./bridge.js";

export * from "./bridge.js";
export * from "./schema.js";

export interface CoreClientEvents {
  decode: [DecodeEvent];
  status: [DaemonStatus];
  slotClock: [SlotClockSpec];
  txState: [TxStatus];
  tx: [TxEvent];
  log: [LogEvent];
  error: [ErrorMessage];
}

export interface CoreClientOptions {
  autoClaim?: boolean;
  token?: string;
  myCall?: string;
  myGrid?: string;
}

export interface CoreClient {
  readonly isConnected: boolean;
  readonly status: DaemonStatus | null;
  readonly clock: SlotClock | null;
  readonly identity: { call: string; grid: string };
  readonly txStatus: TxStatus;

  on<K extends keyof CoreClientEvents>(event: K, listener: (...args: CoreClientEvents[K]) => void): () => void;
  off<K extends keyof CoreClientEvents>(event: K, listener: (...args: CoreClientEvents[K]) => void): void;
  emit<K extends keyof CoreClientEvents>(event: K, ...args: CoreClientEvents[K]): boolean;

  // Station commands
  transmit(intent: { af: number; slot: TxSlot; message: string }): boolean;
  cancelTransmit(): boolean;
  haltTx(): boolean;
  setIdentity(call: string, grid: string): void;
  setDialFreq(mhz: number | null): boolean;
  setAf(af: number): void;
  setSlot(slot: TxSlot): void;
  callCq(slot?: TxSlot, identity?: { myCall?: string; myGrid?: string }): void;
  stopCq(reason?: string): void;
  replyToCall(call: string, identity?: { myCall?: string; myGrid?: string }): void;
  setTxEnabled(enabled: boolean): void;
  claimControl(token?: string): boolean;
  releaseControl(): boolean;
  getStatus(): boolean;
  getConfig(): boolean;

  connect(): void;
  close(): void;
}

export class CoreClientImpl implements CoreClient {
  private readonly transport: TransportAdapter;
  private readonly emitter = new EventEmitter();
  private readonly options: CoreClientOptions;
  private unsubscribeTransport?: () => void;

  private _status: DaemonStatus | null = null;
  private _clock: SlotClock | null = null;
  private _myCall = "";
  private _myGrid = "";
  private _txStatus: TxStatus = {
    state: "idle",
    af: null,
    slot: null,
    message: null
  };
  private _currentAf = 1000;
  private _currentSlot: TxSlot = "even";
  private _txEnabled = true;

  constructor(transport: TransportAdapter, options: CoreClientOptions = {}) {
    this.transport = transport;
    this.options = options;
    if (options.myCall) this._myCall = options.myCall.toUpperCase();
    if (options.myGrid) this._myGrid = options.myGrid.toUpperCase();

    this.initTransport();
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  get status(): DaemonStatus | null {
    return this._status;
  }

  get clock(): SlotClock | null {
    return this._clock;
  }

  get identity(): { call: string; grid: string } {
    return { call: this._myCall, grid: this._myGrid };
  }

  get txStatus(): TxStatus {
    return this._txStatus;
  }

  private initTransport(): void {
    this.unsubscribeTransport = this.transport.onMessage((msg: ServerMessage) => {
      this.handleServerMessage(msg);
    });
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "decode":
        this.emitter.emit("decode", msg);
        break;
      case "status":
        this._status = msg;
        this._clock = new SlotClock(msg.clock);
        if (msg.session.callsign) this._myCall = msg.session.callsign;
        if (msg.session.grid) this._myGrid = msg.session.grid;
        this._txStatus = msg.tx;
        this.emitter.emit("status", msg);
        this.emitter.emit("slotClock", msg.clock);
        this.emitter.emit("txState", msg.tx);
        break;
      case "tx":
        this.emitter.emit("tx", msg);
        break;
      case "tx_update":
        this._txStatus = {
          state: msg.state,
          af: msg.af,
          slot: msg.slot,
          message: msg.message
        };
        this.emitter.emit("txState", this._txStatus);
        break;
      case "log":
        this.emitter.emit("log", msg);
        break;
      case "error":
        this.emitter.emit("error", msg);
        break;
    }
  }

  on<K extends keyof CoreClientEvents>(event: K, listener: (...args: CoreClientEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.off(event, listener);
  }

  off<K extends keyof CoreClientEvents>(event: K, listener: (...args: CoreClientEvents[K]) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof CoreClientEvents>(event: K, ...args: CoreClientEvents[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  connect(): void {
    if (this.transport.connect) {
      this.transport.connect();
    }
  }

  close(): void {
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = undefined;
    }
    if (this.transport.close) {
      this.transport.close();
    }
    this.emitter.removeAllListeners();
  }

  transmit(intent: { af: number; slot: TxSlot; message: string }): boolean {
    if (!this._txEnabled) {
      return false;
    }
    return this.transport.send({
      type: "transmit",
      af: intent.af,
      slot: intent.slot,
      message: intent.message
    });
  }

  cancelTransmit(): boolean {
    return this.transport.send({ type: "cancel_transmit" });
  }

  haltTx(): boolean {
    this._txEnabled = false;
    const ok = this.cancelTransmit();
    this.emitter.emit("log", {
      type: "log",
      level: "warn",
      message: "Transmitter halted by operator policy"
    });
    return ok;
  }

  setIdentity(call: string, grid: string): void {
    this._myCall = call.trim().toUpperCase();
    this._myGrid = grid.trim().toUpperCase();
  }

  setDialFreq(mhz: number | null): boolean {
    // If we have an active session or config, frequency can be adjusted via setDialFreq command
    // or through CAT/status.
    if (mhz !== null && (!Number.isFinite(mhz) || mhz <= 0)) {
      return false;
    }
    return true;
  }

  setAf(af: number): void {
    if (Number.isInteger(af) && af >= 200 && af <= 3000) {
      this._currentAf = af;
    }
  }

  setSlot(slot: TxSlot): void {
    this._currentSlot = slot;
  }

  callCq(slot?: TxSlot, identity?: { myCall?: string; myGrid?: string }): void {
    if (identity?.myCall) this._myCall = identity.myCall.toUpperCase();
    if (identity?.myGrid) this._myGrid = identity.myGrid.toUpperCase();
    const activeSlot = slot ?? this._currentSlot;
    const msg = `CQ ${this._myCall} ${this._myGrid}`.trim();
    this.transmit({ af: this._currentAf, slot: activeSlot, message: msg });
  }

  stopCq(_reason?: string): void {
    this.cancelTransmit();
  }

  replyToCall(call: string, identity?: { myCall?: string; myGrid?: string }): void {
    if (identity?.myCall) this._myCall = identity.myCall.toUpperCase();
    if (identity?.myGrid) this._myGrid = identity.myGrid.toUpperCase();
    const msg = `${call} ${this._myCall} ${this._myGrid}`.trim();
    this.transmit({ af: this._currentAf, slot: this._currentSlot, message: msg });
  }

  setTxEnabled(enabled: boolean): void {
    this._txEnabled = enabled;
  }

  claimControl(token?: string): boolean {
    return this.transport.send({
      type: "claim_control",
      ...(token ?? this.options.token ? { token: token ?? this.options.token } : {})
    });
  }

  releaseControl(): boolean {
    return this.transport.send({ type: "release_control" });
  }

  getStatus(): boolean {
    return this.transport.send({ type: "get_status" });
  }

  getConfig(): boolean {
    return this.transport.send({ type: "get_config" });
  }
}

export function createCoreClient(transport: TransportAdapter, options?: CoreClientOptions): CoreClient {
  return new CoreClientImpl(transport, options);
}
