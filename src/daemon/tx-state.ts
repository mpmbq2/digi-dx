import { EventEmitter } from "node:events";
import type { TxIntent, TxStatus, TxUpdateEvent } from "./protocol.js";
import { DaemonError } from "./protocol.js";

export interface TxStateEvents {
  txUpdate: [TxUpdateEvent];
}

export interface TxStateOptions {
  transmit: (intent: TxIntent) => Promise<void> | void;
  cancelTransmit: () => Promise<void> | void;
  now?: () => number;
  stopTimeoutMs?: number;
}

export class TxState extends EventEmitter<TxStateEvents> {
  private desiredTx: TxIntent | null = null;
  private activeTx: TxIntent | null = null;
  private waiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: TxStateOptions) {
    super();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1000;
  }

  snapshot(): TxStatus {
    const publicTx = this.activeTx ?? this.desiredTx;
    return {
      state: this.activeTx ? "active" : this.desiredTx ? "pending" : "idle",
      af: publicTx?.af ?? null,
      slot: publicTx?.slot ?? null,
      message: publicTx?.message ?? null
    };
  }

  async transmit(intent: TxIntent): Promise<TxUpdateEvent> {
    if (this.activeTx && this.activeTx.slot !== intent.slot) {
      await this.writeStop();
      await this.waitForInactive();
    }

    this.desiredTx = intent;
    await this.forward(intent);
    const event = this.makeUpdate();
    this.emit("txUpdate", event);
    return event;
  }

  async cancel(): Promise<TxUpdateEvent> {
    this.desiredTx = null;
    this.activeTx = null;
    await this.writeStop();
    this.resolveWaiters();
    const event = this.makeUpdate();
    this.emit("txUpdate", event);
    return event;
  }

  markEngineTx(active: boolean): void {
    if (active) {
      this.activeTx = this.desiredTx;
    } else {
      this.activeTx = null;
    }
    if (!active) {
      this.resolveWaiters();
    }
  }

  clear(): void {
    this.desiredTx = null;
    this.activeTx = null;
    this.resolveWaiters();
  }

  private async forward(intent: TxIntent): Promise<void> {
    try {
      await this.options.transmit(intent);
    } catch (error) {
      throw new DaemonError("TX_FAILED", "failed to write transmit command", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeStop(): Promise<void> {
    try {
      await this.options.cancelTransmit();
    } catch (error) {
      throw new DaemonError("TX_FAILED", "failed to write STOP command", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async waitForInactive(): Promise<void> {
    if (!this.activeTx) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== onDone);
        resolve();
      }, this.stopTimeoutMs);
      const onDone = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.waiters.push(onDone);
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private makeUpdate(): TxUpdateEvent {
    const tx = this.snapshot();
    return {
      type: "tx_update",
      ts: this.now(),
      af: tx.af,
      slot: tx.slot,
      message: tx.message,
      state: tx.state
    };
  }
}
