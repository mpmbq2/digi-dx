// Single source of truth for the daemon <-> client wire contract.
//
// These are the JSON message shapes and shared domain types that cross the
// WebSocket boundary between the daemon (src/daemon) and every client (the TUI,
// the web server, the CLI). The daemon re-exports them from
// src/daemon/protocol.ts (which additionally owns the server-side DaemonError
// class and the parse/validate helpers); clients import them directly instead
// of re-declaring the shapes or casting `msg.x as T` inline.

export const errorCodes = [
  "INVALID_COMMAND",
  "VALIDATION_FAILED",
  "CONTROL_REQUIRED",
  "CONTROL_UNAVAILABLE",
  "AUTH_FAILED",
  "CONFIG_REQUIRED",
  "CONFIG_INVALID",
  "CONFIG_WRITE_FAILED",
  "SESSION_ALREADY_ACTIVE",
  "NO_ACTIVE_SESSION",
  "SOUND_DEVICE_UNAVAILABLE",
  "AUDIO_DISCOVERY_FAILED",
  "CAT_FAILED",
  "CAT_PORT_UNAVAILABLE",
  "UDP_BIND_FAILED",
  "ENGINE_START_FAILED",
  "PROCESS_CRASHED",
  "TX_FAILED"
] as const;

export type ErrorCode = (typeof errorCodes)[number];
export type CommandId = string | number;

export type TxSlot = "even" | "odd";
export type TxPublicState = "idle" | "pending" | "active";

// Persisted session configuration. Lives here (not in src/daemon/config.ts)
// because it is part of the wire contract: `status` carries `device`, and
// `save_config`/`start_session` carry a full `session`. The daemon's config
// module re-exports this type and owns the runtime validation/persistence.
export interface SessionConfig {
  mode: "FT8";
  device: {
    id: number;
    name?: string;
  };
  callsign: string;
  grid: string;
  cat: {
    mode: "rigctld" | "dummy";
    port: number;
  };
}

export interface TxIntent {
  af: number;
  slot: TxSlot;
  message: string;
}

export interface TxStatus {
  state: TxPublicState;
  af: number | null;
  slot: TxSlot | null;
  message: string | null;
}

export interface DaemonStatus {
  type: "status";
  id?: CommandId;
  session: {
    active: boolean;
    mode: "FT8" | null;
    device: SessionConfig["device"] | null;
    catConnected: boolean;
    freq: number | null;
    ptt: boolean;
    callsign: string | null;
    grid: string | null;
  };
  tx: TxStatus;
  control: {
    held: boolean;
    byThisClient: boolean;
  };
}

export interface DecodeEvent {
  type: "decode";
  ts: number;
  snr: number;
  dt: number;
  af: number;
  mode: "FT8" | "FT4";
  message: string;
}

export interface TxEvent {
  type: "tx";
  ts: number;
  af: number;
  mode: "FT8" | "FT4";
  message: string;
}

export interface TxUpdateEvent {
  type: "tx_update";
  ts: number;
  af: number | null;
  slot: TxSlot | null;
  message: string | null;
  state: TxPublicState;
}

export interface LogEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

export type BroadcastEvent = DecodeEvent | TxEvent | TxUpdateEvent | LogEvent;

export interface ErrorMessage {
  id?: CommandId;
  type: "error";
  code: ErrorCode;
  message: string;
  details?: unknown;
}

// --- audio + config messages -----------------------------------------------

export interface AudioDevice {
  id: number;
  name: string;
  inputs: number;
  outputs: number;
  defaultSampleRate: number | null;
}

export interface ConfigMessage {
  type: "config";
  id?: CommandId;
  session: SessionConfig | null;
  complete: boolean;
  missing?: string[];
  invalid?: boolean;
  error?: string;
}

export interface AudioDevicesMessage {
  type: "audio_devices";
  id?: CommandId;
  devices: AudioDevice[];
}

// Every message the daemon can push to a client, discriminated by `type`.
export type ServerMessage =
  | DaemonStatus
  | DecodeEvent
  | TxEvent
  | TxUpdateEvent
  | LogEvent
  | ErrorMessage
  | ConfigMessage
  | AudioDevicesMessage;

// --- client -> daemon commands ---------------------------------------------

// The commands a client can send. The transport tags each with an `id`; the
// daemon validates `session` shapes, so they stay loosely typed here.
export type DaemonCommand =
  | { type: "claim_control"; token?: string }
  | { type: "release_control" }
  | { type: "get_status" }
  | { type: "get_config" }
  | { type: "list_audio_devices" }
  | { type: "save_config"; session: unknown }
  | { type: "start_session"; session?: unknown }
  | { type: "stop_session" }
  | { type: "transmit"; af: number; slot: TxSlot; message: string }
  | { type: "cancel_transmit" };
