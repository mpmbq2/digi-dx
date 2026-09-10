import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PttWatchdog } from "../src/edge/watchdog.js";
import { Engine } from "../src/daemon/engine.js";
import { createDaemonWebSocketServer } from "../src/daemon/websocket.js";
import type { EngineDriver, EngineDriverEvents } from "../src/daemon/engine-driver.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "../src/daemon/protocol.js";
import type { AudioDevice } from "../src/daemon/audio-devices.js";
import { SimulatedDriver } from "../src/daemon/simulated-driver.js";
import { realtimeClockSpec } from "../core/slot-clock.js";
import { WebSocket } from "ws";

class MockDriver extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  readonly kind: EngineKind = "ft8cat";
  cancelTransmitCalled = false;
  transmitCalled = false;

  clock(): SlotClockSpec {
    return realtimeClockSpec();
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async transmit(_intent: TxIntent): Promise<void> {
    this.transmitCalled = true;
  }
  async cancelTransmit(): Promise<void> {
    this.cancelTransmitCalled = true;
    this.emit("ptt", false);
  }
  async listAudioDevices(): Promise<AudioDevice[]> {
    return [];
  }
  emitPtt(active: boolean): void {
    this.emit("ptt", active);
  }
}

describe("PttWatchdog and Fail-Safe (U2, R4, AE1)", () => {
  it("arms with specified timeout and triggers callback when unpetted", async () => {
    let timedOut = false;
    const watchdog = new PttWatchdog({
      timeoutMs: 50,
      onTimeout: () => {
        timedOut = true;
      }
    });

    expect(watchdog.isArmed).toBe(false);
    watchdog.arm();
    expect(watchdog.isArmed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(timedOut).toBe(true);
    expect(watchdog.isArmed).toBe(false);
    expect(watchdog.hasTimedOut).toBe(true);
  });

  it("sliding pet prevents watchdog from timing out", async () => {
    let timedOut = false;
    const watchdog = new PttWatchdog({
      timeoutMs: 60,
      onTimeout: () => {
        timedOut = true;
      }
    });

    watchdog.arm();

    // Pet every 30ms for 120ms (well past the 60ms timeout)
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      watchdog.pet();
      expect(timedOut).toBe(false);
    }

    watchdog.disarm();
    expect(watchdog.isArmed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(timedOut).toBe(false);
  });

  it("disarm cancels pending timeout", async () => {
    let timedOut = false;
    const watchdog = new PttWatchdog({
      timeoutMs: 40,
      onTimeout: () => {
        timedOut = true;
      }
    });

    watchdog.arm();
    watchdog.disarm();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(timedOut).toBe(false);
    expect(watchdog.isArmed).toBe(false);
  });

  it("integrates with Engine: drops PTT within 500ms when heartbeat is interrupted (AE1)", async () => {
    const driver = new MockDriver();
    const simulatedDriver = new SimulatedDriver();
    const logEvents: string[] = [];

    const engine = new Engine({
      driver,
      simulatedDriver,
      enableWatchdog: true,
      watchdogTimeoutMs: 100 // 100ms for fast test execution
    });

    engine.on("event", (evt) => {
      if (evt.type === "log") {
        logEvents.push(evt.message);
      }
    });

    await engine.start({
      mode: "FT8",
      device: { id: 1 },
      callsign: "W1AW",
      grid: "FN31",
      cat: { mode: "dummy", port: 0 }
    });

    // Start transmission
    await engine.transmit({
      af: 1000,
      slot: "even",
      message: "CQ W1AW FN31"
    });

    // Simulate driver asserting PTT
    driver.emitPtt(true);
    expect(engine.snapshot().ptt).toBe(true);
    expect(engine.isWatchdogArmed()).toBe(true);

    // Stop petting; wait for watchdog timeout (>100ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Watchdog must have tripped, cancelling transmit and de-asserting PTT
    expect(engine.snapshot().ptt).toBe(false);
    expect(engine.isWatchdogArmed()).toBe(false);
    expect(driver.cancelTransmitCalled).toBe(true);
    expect(logEvents.some((msg) => msg.includes("fail-safe: watchdog timeout, PTT de-asserted"))).toBe(true);

    await engine.stop();
  });

  it("keeps transmission active when petted regularly without false watchdog trip", async () => {
    const driver = new MockDriver();
    const simulatedDriver = new SimulatedDriver();

    const engine = new Engine({
      driver,
      simulatedDriver,
      enableWatchdog: true,
      watchdogTimeoutMs: 100
    });

    await engine.start({
      mode: "FT8",
      device: { id: 1 },
      callsign: "W1AW",
      grid: "FN31",
      cat: { mode: "dummy", port: 0 }
    });

    await engine.transmit({
      af: 1000,
      slot: "even",
      message: "CQ W1AW FN31"
    });
    driver.emitPtt(true);
    expect(engine.snapshot().ptt).toBe(true);

    // Pet every 40ms for 200ms (twice the watchdog timeout)
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      engine.petWatchdog();
      expect(engine.snapshot().ptt).toBe(true);
      expect(driver.cancelTransmitCalled).toBe(false);
    }

    // Clean cancellation
    await engine.cancelTransmit();
    expect(engine.snapshot().ptt).toBe(false);
    expect(engine.isWatchdogArmed()).toBe(false);

    await engine.stop();
  });

  it("immediately aborts PTT when controlling client disconnects over WebSocket", async () => {
    const driver = new MockDriver();
    const simulatedDriver = new SimulatedDriver();

    const engine = new Engine({
      driver,
      simulatedDriver,
      enableWatchdog: true,
      watchdogTimeoutMs: 500
    });

    await engine.start({
      mode: "FT8",
      device: { id: 1 },
      callsign: "W1AW",
      grid: "FN31",
      cat: { mode: "dummy", port: 0 }
    });

    const daemon = createDaemonWebSocketServer({
      engine,
      port: 8798,
      enableWatchdog: true,
      watchdogTimeoutMs: 500
    });

    try {
      const client = new WebSocket("ws://127.0.0.1:8798");
      await new Promise((resolve) => client.on("open", resolve));

      // Claim control
      client.send(JSON.stringify({ type: "claim_control" }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Transmit
      client.send(JSON.stringify({ type: "transmit", af: 1200, slot: "even", message: "CQ W1AW FN31" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      driver.emitPtt(true);
      expect(engine.snapshot().ptt).toBe(true);

      // Abruptly terminate controlling connection
      client.terminate();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // PTT must be dropped immediately on controller close
      expect(engine.snapshot().ptt).toBe(false);
      expect(driver.cancelTransmitCalled).toBe(true);
    } finally {
      await daemon.close();
      await engine.stop();
    }
  });
});
