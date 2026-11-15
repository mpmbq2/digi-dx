import type { DaemonCommand, ServerMessage } from "../protocol.js";

// Generic transport abstraction for CoreClient. Allows running over:
// 1. Direct WebSocket connection (DaemonClient or native browser WebSocket)
// 2. postMessage RPC bridge in an isolated iframe sandbox
// 3. In-memory mock adapter for deterministic unit/integration testing

export interface TransportAdapter {
  send(command: DaemonCommand): boolean;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  connect?(): void;
  close?(): void;
  readonly isConnected: boolean;
}

export class MockTransportAdapter implements TransportAdapter {
  private handlers = new Set<(msg: ServerMessage) => void>();
  private sent: DaemonCommand[] = [];
  private connected = true;

  get isConnected(): boolean {
    return this.connected;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  send(command: DaemonCommand): boolean {
    if (!this.connected) {
      return false;
    }
    this.sent.push(command);
    return true;
  }

  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Simulate pushing a message from the remote daemon/engine into the client
  receive(message: ServerMessage): void {
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  getSentCommands(): DaemonCommand[] {
    return [...this.sent];
  }

  clearSentCommands(): void {
    this.sent.length = 0;
  }

  connect(): void {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }
}

// Adapts a postMessage window/port (such as inside a sandbox iframe) into TransportAdapter
export class PostMessageBridgeAdapter implements TransportAdapter {
  private target: { postMessage: (message: unknown, targetOrigin?: string) => void };
  private handlers = new Set<(msg: ServerMessage) => void>();
  private connected = true;
  private channelId: string;

  constructor(target: { postMessage: (message: unknown, targetOrigin?: string) => void }, channelId = "digi-dx-sandbox") {
    this.target = target;
    this.channelId = channelId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  send(command: DaemonCommand): boolean {
    if (!this.connected) {
      return false;
    }
    try {
      this.target.postMessage({ channel: this.channelId, type: "rpc_command", payload: command }, "*");
      return true;
    } catch {
      return false;
    }
  }

  onMessage(handler: (msg: ServerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Incoming postMessage receiver
  dispatchIncoming(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const packet = data as { channel?: string; type?: string; payload?: ServerMessage };
    if (packet.channel === this.channelId && packet.type === "rpc_event" && packet.payload) {
      for (const handler of this.handlers) {
        handler(packet.payload);
      }
    }
  }

  close(): void {
    this.connected = false;
  }
}
