import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realtimeClockSpec } from "../core/slot-clock.js";
import { DaemonClient } from "../core/daemon-client.js";
import { createOperatorController, type OperatorController, type QsoLogStore } from "../core/controller.js";
import type { AudioDevice } from "../src/daemon/audio-devices.js";
import { Engine } from "../src/daemon/engine.js";
import type { EngineDriver, EngineDriverEvents } from "../src/daemon/engine-driver.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "../src/daemon/protocol.js";
import { SimulatedDriver } from "../src/daemon/simulated-driver.js";
import { isNonAssignableCallsign } from "../src/daemon/sim-station.js";
import { createDaemonWebSocketServer, type DaemonWebSocketServer } from "../src/daemon/websocket.js";
import type { QsoLogEntry } from "../core/qso.js";

// Stands in for the real radio; a demo session must never select it.
class RealDriverStub extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  readonly kind: EngineKind = "ft8cat";
  started = 0;
  clock(): SlotClockSpec {
    return realtimeClockSpec();
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {}
  async transmit(_intent: TxIntent): Promise<void> {}
  async cancelTransmit(): Promise<void> {}
  async listAudioDevices(): Promise<AudioDevice[]> {
    return [];
  }
}

class MemoryQsoLog implements QsoLogStore {
  readonly entries: QsoLogEntry[] = [];
  async append(entry: QsoLogEntry): Promise<void> {
    this.entries.push(entry);
  }
  async readAll(): Promise<QsoLogEntry[]> {
    return this.entries;
  }
}

const servers: DaemonWebSocketServer[] = [];
const controllers: OperatorController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startSimDaemon(scale: number): Promise<{ url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "digi-dx-ctl-"));
  const configPath = join(dir, "config.json"); // absent on purpose
  const engine = new Engine({
    driver: new RealDriverStub(),
    simulatedDriver: new SimulatedDriver({ scale, seed: 7 })
  });
  const port = 18990 + Math.floor(Math.random() * 900);
  const server = createDaemonWebSocketServer({ engine, port, configPath });
  servers.push(server);
  return { url: `ws://127.0.0.1:${port}` };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("OperatorController end-to-end against the simulated driver", () => {
  it("drives a full simulated QSO to completion and logs it, at scaled time", async () => {
    const scale = 100;
    const { url } = await startSimDaemon(scale);
    const log = new MemoryQsoLog();
    const client = new DaemonClient({ url, reconnectMs: 2000 });
    const controller = createOperatorController({ client, log });
    controllers.push(controller);

    controller.start();
    await waitFor(() => client.connected, 15_000, "daemon connection");

    // Start the demo session: the daemon selects the simulated engine, synthesizes
    // a demo identity, and publishes its scaled clock. The controller adopts all
    // three from status; simulated stations then call the demo callsign and the
    // automation works the QSO from this side with no further operator action.
    const startedAt = Date.now();
    controller.startDemo();
    await waitFor(
      () => Boolean(controller.state.station.sessionActive && controller.state.station.demo && controller.state.clock),
      15_000,
      "demo session live"
    );
    expect(controller.state.clock?.spec.scale).toBe(scale);

    // The engine completes and logs a QSO end to end, headless.
    await waitFor(() => log.entries.length > 0, 25_000, "a completed QSO in the log");
    const elapsedWallMs = Date.now() - startedAt;

    const entry = log.entries[0]!;
    expect(entry.theirCall).toBeTruthy();
    // Demo contacts can never be a real licensee.
    expect(isNonAssignableCallsign(entry.theirCall)).toBe(true);
    expect(entry.sentReport).toBeTruthy();
    expect(entry.receivedReport).toBeTruthy();

    // Scale integrity (R5): a full QSO spans ~6 FT8 slots (~90 virtual seconds).
    // At scale 100 that is ~1s of wall time; a scheduler that ignored the scale
    // factor and armed on real 15-second boundaries could not finish inside this
    // budget, so completing under it proves the scheduler honored the clock.
    expect(elapsedWallMs).toBeLessThan(30_000);
  }, 40_000);
});
