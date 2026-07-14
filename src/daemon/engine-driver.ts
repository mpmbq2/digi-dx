import { EventEmitter } from "node:events";
import type { SessionConfig } from "./config.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "./protocol.js";
import type { AudioDevice } from "./audio-devices.js";
import type { DecodeEvent, TxEvent } from "./protocol.js";

export interface DriverDecode {
  ts: number;
  snr: number;
  dt: number;
  af: number;
  mode: "FT8" | "FT4";
  message: string;
}

export interface DriverTx {
  ts: number;
  af: number;
  mode: "FT8" | "FT4";
  message: string;
}

export interface EngineDriverEvents {
  decode: [DriverDecode];
  tx: [DriverTx];
  freq: [number];
  ptt: [boolean];
  crash: [Error];
}

export interface EngineDriver extends EventEmitter<EngineDriverEvents> {
  // Which engine is behind the seam. The daemon publishes this so clients can
  // label demo mode and route the QSO log away from the operator's real one.
  readonly kind: EngineKind;
  // The driver owns the time base: only it knows whether time is scaled. The
  // real driver reports a wall-anchored, scale-1 clock, which makes virtual
  // time identical to wall time and leaves the live path unchanged.
  clock(): SlotClockSpec;
  start(session: SessionConfig): Promise<void>;
  stop(): Promise<void>;
  transmit(intent: TxIntent): Promise<void>;
  cancelTransmit(): Promise<void>;
  listAudioDevices(): Promise<AudioDevice[]>;
}

export function driverDecodeToEvent(decode: DriverDecode): DecodeEvent {
  return {
    type: "decode",
    ts: decode.ts,
    snr: decode.snr,
    dt: decode.dt,
    af: decode.af,
    mode: decode.mode,
    message: decode.message.toUpperCase()
  };
}

export function driverTxToEvent(tx: DriverTx): TxEvent {
  return {
    type: "tx",
    ts: tx.ts,
    af: tx.af,
    mode: tx.mode,
    message: tx.message.toUpperCase()
  };
}

export function encodeTransmitLine(intent: TxIntent): string {
  const slot = intent.slot === "even" ? "E" : "O";
  return `${intent.af}${slot} ${intent.message}`;
}
