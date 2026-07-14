// The wire types (message shapes + shared domain types that cross the WebSocket
// boundary) live in core/protocol.ts as the single source of truth. This module
// re-exports them and additionally owns the server-side DaemonError class and
// the parse/validate helpers used only by the daemon.
export type {
  CommandId,
  ErrorCode,
  EngineKind,
  SlotClockSpec,
  TxSlot,
  TxPublicState,
  SessionConfig,
  TxIntent,
  TxStatus,
  DaemonStatus,
  DecodeEvent,
  TxEvent,
  TxUpdateEvent,
  LogEvent,
  BroadcastEvent,
  ErrorMessage
} from "../../core/protocol.js";
export { errorCodes } from "../../core/protocol.js";

import type { CommandId, ErrorCode, ErrorMessage, TxIntent } from "../../core/protocol.js";

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
