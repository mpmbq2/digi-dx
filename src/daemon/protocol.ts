import type { SessionConfig } from "./config.js";

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

export class DaemonError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export function protocolError(id: CommandId | undefined, error: unknown): ErrorMessage {
  if (error instanceof DaemonError) {
    return {
      id,
      type: "error",
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }

  return {
    id,
    type: "error",
    code: "INVALID_COMMAND",
    message: "command failed"
  };
}

export function parseJsonCommand(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DaemonError("INVALID_COMMAND", "message must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DaemonError("INVALID_COMMAND", "message must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function getCommandId(command: Record<string, unknown>): CommandId | undefined {
  const id = command.id;
  if (typeof id === "string" || typeof id === "number") {
    return id;
  }
  return undefined;
}

export function normalizeTransmit(command: Record<string, unknown>): TxIntent {
  const af = command.af;
  if (!Number.isInteger(af) || (af as number) < 200 || (af as number) > 3000) {
    throw new DaemonError("VALIDATION_FAILED", "transmit.af must be an integer from 200 to 3000", {
      field: "af"
    });
  }

  if (command.slot !== "even" && command.slot !== "odd") {
    throw new DaemonError("VALIDATION_FAILED", "transmit.slot must be 'even' or 'odd'", {
      field: "slot"
    });
  }

  if (typeof command.message !== "string") {
    throw new DaemonError("VALIDATION_FAILED", "transmit.message is required", {
      field: "message"
    });
  }

  const message = command.message.trim().toUpperCase();
  if (message.length === 0 || message.length > 128 || /[\r\n\p{Cc}]/u.test(message)) {
    throw new DaemonError(
      "VALIDATION_FAILED",
      "transmit.message must be non-empty, at most 128 characters, and contain no control characters",
      { field: "message" }
    );
  }

  return {
    af: af as number,
    slot: command.slot,
    message
  };
}

export function sendJson(send: (data: string) => void, payload: unknown): void {
  send(JSON.stringify(payload));
}
