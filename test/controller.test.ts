import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../core/daemon-client.js";
import {
  createOperatorController,
  type ControllerState,
  type OperatorController,
  type QsoLogStore
} from "../core/controller.js";
import { realtimeClockSpec, type SlotClockSpec } from "../core/slot-clock.js";
import type { DaemonCommand, DaemonStatus, EngineKind } from "../core/protocol.js";
import type { QsoLogEntry } from "../core/qso.js";

// A DaemonClient that never opens a socket: connect/close are no-ops, send just
// records the command, and tests drive the controller by emitting daemon events
// on it directly (it is a real EventEmitter, so the controller's subscriptions
// fire exactly as they would against a live daemon).
class FakeDaemonClient extends DaemonClient {
  readonly sent: DaemonCommand[] = [];
  constructor() {
    super({ url: "ws://test" });
  }
  override connect(): void {}
  override close(): void {}
  override send(command: DaemonCommand): boolean {
    this.sent.push(command);
    return true;
  }
}

class MemoryQsoLog implements QsoLogStore {
  readonly entries: Array<{ entry: QsoLogEntry; engine: EngineKind }> = [];
  async append(entry: QsoLogEntry, engine: EngineKind): Promise<void> {
    this.entries.push({ entry, engine });
  }
  async readAll(): Promise<QsoLogEntry[]> {
    return this.entries.map((e) => e.entry);
  }
}

function statusMessage(overrides?: {
  active?: boolean;
  byThisClient?: boolean;
  held?: boolean;
  engine?: EngineKind;
  clock?: SlotClockSpec;
  txState?: "idle" | "pending" | "active";
  callsign?: string | null;
  grid?: string | null;
}): DaemonStatus {
  return {
    type: "status",
    engine: overrides?.engine ?? "ft8cat",
    clock: overrides?.clock ?? realtimeClockSpec(),
    session: {
      active: overrides?.active ?? true,
      mode: "FT8",
      device: null,
      catConnected: true,
      freq: null,
      ptt: false,
      callsign: overrides?.callsign ?? null,
      grid: overrides?.grid ?? null
    },
    tx: { state: overrides?.txState ?? "idle", af: null, slot: null, message: null },
    control: { held: overrides?.held ?? true, byThisClient: overrides?.byThisClient ?? true }
  };
}

function build(): {
  controller: OperatorController;
  client: FakeDaemonClient;
  log: MemoryQsoLog;
} {
  const client = new FakeDaemonClient();
  const log = new MemoryQsoLog();
  const controller = createOperatorController({ client, log });
  controller.start();
  return { controller, client, log };
}

const sentTypes = (client: FakeDaemonClient): string[] => client.sent.map((c) => c.type);

describe("OperatorController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits state to listeners and stops after unsubscribe", () => {
    const { controller } = build();
    const seen: ControllerState[] = [];
    const off = controller.onChange((s) => seen.push(s));
    controller.setIdentity("N1MPM", "FN42");
    expect(seen.length).toBeGreaterThan(0);
    off();
    const before = seen.length;
    controller.setIdentity("N1MPM", "FN43");
    expect(seen.length).toBe(before);
  });

  it("starts idle: no demo, empty collections", () => {
    const { controller } = build();
    const s = controller.state;
    expect(s.station.demo).toBe(false);
    expect(s.qsos.active).toEqual([]);
    expect(s.qsos.completed).toEqual([]);
    expect(s.decodes).toEqual([]);
    expect(s.tx.enabled).toBe(true);
  });

  it("labels demo mode when the simulated engine is running", () => {
    const { controller, client } = build();
    client.emit("status", statusMessage({ engine: "simulated" }));
    expect(controller.state.station.demo).toBe(true);
  });

  it("dispose clears timers and unsubscribes from the client", () => {
    const { controller, client } = build();
    client.emit("status", statusMessage());
    controller.dispose();
    const seen: ControllerState[] = [];
    controller.onChange((s) => seen.push(s));
    // After dispose the controller no longer reacts to daemon events.
    client.emit("status", statusMessage({ engine: "simulated" }));
    expect(seen.length).toBe(0);
    expect(controller.state.station.demo).toBe(false);
  });

  it("a state-changing action claims control when it is not held by us", () => {
    const { controller, client } = build();
    // Config incomplete, so start_session won't fire — but control is still claimed.
    client.emit("status", statusMessage({ byThisClient: false, held: false }));
    controller.startSession();
    expect(sentTypes(client)).toContain("claim_control");
    expect(sentTypes(client)).not.toContain("start_session");
  });

  it("schedules and sends an automated CQ at the slot with control and a valid AF", () => {
    const { controller, client } = build();
    controller.setIdentity("N1MPM", "FN42");
    client.emit("status", statusMessage({ byThisClient: true }));
    controller.setAf(1200);
    controller.callCq("even");
    // Timer armed ~2s before the next even slot (opens at t=30s at scale 1);
    // advance past it to fire the transmit.
    vi.advanceTimersByTime(31_000);
    const transmit = client.sent.find((c) => c.type === "transmit");
    expect(transmit).toBeDefined();
    expect((transmit as { message: string }).message).toMatch(/^CQ N1MPM FN42/);
  });

  it("does not transmit while TX is disabled", () => {
    const { controller, client } = build();
    controller.setIdentity("N1MPM", "FN42");
    client.emit("status", statusMessage({ byThisClient: true }));
    controller.setAf(1200);
    controller.setTxEnabled(false);
    controller.callCq("even");
    vi.advanceTimersByTime(20_000);
    expect(sentTypes(client)).not.toContain("transmit");
  });

  it("survey holds TX and refuses without a slot clock", () => {
    const { controller, client } = build();
    // No status yet => no clock => survey refuses.
    controller.survey();
    expect(controller.state.survey.active).toBe(false);
    // With a clock, survey engages.
    controller.setIdentity("N1MPM", "FN42");
    client.emit("status", statusMessage({ byThisClient: true }));
    controller.survey();
    expect(controller.state.survey.active).toBe(true);
  });

  it("logs exactly one entry when a standard QSO completes", async () => {
    const { controller, client, log } = build();
    controller.setIdentity("N1MPM", "FN42");
    client.emit("status", statusMessage({ byThisClient: true }));
    controller.replyToCall("JA2KVB");
    const id = controller.state.qsos.active[0]?.id;
    expect(id).toBeDefined();
    controller.qsoAction(id!, "complete");
    await vi.runAllTimersAsync();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.entry.theirCall).toBe("JA2KVB");
  });

  it("persists the dial frequency through the injected state store", async () => {
    const client = new FakeDaemonClient();
    const log = new MemoryQsoLog();
    const writes: Array<{ dialFreqHz?: number | null }> = [];
    const controller = createOperatorController({
      client,
      log,
      state: {
        read: async () => ({}),
        write: async (patch) => {
          writes.push(patch);
        }
      }
    });
    controller.start();
    controller.setDialFreq(14.074);
    await vi.runAllTimersAsync();
    expect(controller.state.station.dialFreqHz).toBe(14_074_000);
    expect(writes.at(-1)).toEqual({ dialFreqHz: 14_074_000 });
  });
});
