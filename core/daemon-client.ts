import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type {
  AudioDevicesMessage,
  ConfigMessage,
  DaemonCommand,
  DaemonStatus,
  DecodeEvent,
  ErrorMessage,
  LogEvent,
  TxEvent,
  TxUpdateEvent
} from "./protocol.js";

export interface DaemonClientOptions {
  url: string;
  token?: string;
  // When set, the client auto-reconnects this many ms after an unexpected close.
  // Leave undefined for one-shot clients that should stay down once closed.
  reconnectMs?: number;
  logger?: (message: string) => void;
}

export interface DaemonClientEvents {
  open: [];
  close: [];
  status: [DaemonStatus];
  decode: [DecodeEvent];
  tx: [TxEvent];
  tx_update: [TxUpdateEvent];
  log: [LogEvent];
  // Named daemonError, not error: Node's EventEmitter throws when an "error"
  // event is emitted with no listener attached.
  daemonError: [ErrorMessage];
  config: [ConfigMessage];
  audio_devices: [AudioDevicesMessage];
}

// Typed WebSocket client for the daemon protocol, shared by the Node clients
// (TUI, web server, CLI). It owns connect/reconnect and id tagging on send, and
// is the single place raw JSON is narrowed to the wire types — so clients
// subscribe to typed events instead of casting `msg.x as T` inline.
export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private socket: WebSocket | null = null;
  private idCounter = 1;
  private closedByUser = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly url: string;
  private readonly token?: string;
  private readonly reconnectMs?: number;
  private readonly log: (message: string) => void;

  constructor(options: DaemonClientOptions) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.reconnectMs = options.reconnectMs;
    this.log = options.logger ?? (() => {});
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUser = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("open", () => this.emit("open"));
    socket.on("message", (raw) => this.handleRaw(raw.toString()));
    socket.on("error", (error: Error) => this.log(`daemon connection error: ${error.message}`));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.emit("close");
      if (!this.closedByUser && this.reconnectMs !== undefined && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectMs);
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  // Send a command, tagging it with an incrementing id. Returns false when the
  // socket is not open (the caller decides how to surface that).
  send(command: DaemonCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const id = String(this.idCounter++);
    this.socket.send(JSON.stringify({ id, ...command }));
    return true;
  }

  // Convenience for the one token-bearing command, so callers never handle the
  // auth token themselves.
  claimControl(): boolean {
    return this.send({ type: "claim_control", ...(this.token ? { token: this.token } : {}) });
  }

  private handleRaw(raw: string): void {
    let message: { type?: unknown };
    try {
      message = JSON.parse(raw) as { type?: unknown };
    } catch {
      this.log(`bad daemon message: ${raw}`);
      return;
    }

    switch (message.type) {
      case "status":
        this.emit("status", message as DaemonStatus);
        break;
      case "decode":
        this.emit("decode", message as DecodeEvent);
        break;
      case "tx":
        this.emit("tx", message as TxEvent);
        break;
      case "tx_update":
        this.emit("tx_update", message as TxUpdateEvent);
        break;
      case "log":
        this.emit("log", message as LogEvent);
        break;
      case "error":
        this.emit("daemonError", message as ErrorMessage);
        break;
      case "config":
        this.emit("config", message as ConfigMessage);
        break;
      case "audio_devices":
        this.emit("audio_devices", message as AudioDevicesMessage);
        break;
      default:
        this.log(`unknown daemon message type: ${String(message.type)}`);
    }
  }
}
