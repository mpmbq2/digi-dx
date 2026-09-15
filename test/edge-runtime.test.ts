import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EdgeRuntime } from "../src/edge/runtime.js";
import { SimulatedDriver } from "../src/daemon/simulated-driver.js";
import { Engine } from "../src/daemon/engine.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EdgeRuntime & Telemetry (5 Diagnostic Pillars)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "edge-runtime-test-"));
    configPath = join(tmpDir, "config.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("initializes telemetry with all 5 diagnostic pillars in healthy state", async () => {
    const liveDriver = new SimulatedDriver({});
    const simDriver = new SimulatedDriver({});
    const engine = new Engine({ driver: liveDriver, simulatedDriver: simDriver });

    const runtime = new EdgeRuntime({
      configPath,
      forceSimulated: true,
      engine,
      cloudUrl: "ws://127.0.0.1:8795"
    });

    await runtime.init();
    const telem = runtime.getTelemetry();

    // 1. Program & Watchdog Status
    expect(telem.program.status).toBe("healthy");
    expect(telem.program.version).toBe("0.1.0");
    expect(typeof telem.program.uptimeSeconds).toBe("number");
    expect(telem.watchdog.timeoutMs).toBe(500);

    // 2. Configuration Setup
    expect(telem.config.catPort).toBe(4532);
    expect(telem.config.cloudUrl).toBe("ws://127.0.0.1:8795");

    // 3. Server / Cloud Communication
    expect(telem.server.status).toBe("unpaired");
    expect(telem.server.stationId).toBeDefined();

    // 4. Radio CAT Communication
    expect(typeof telem.radio.catConnected).toBe("boolean");
    expect(telem.radio.ptt).toBe(false);

    // 5. FT8 Engine & Audio DSP
    expect(telem.ft8.slotParity).toMatch(/^(even|odd)$/);
    expect(telem.ft8.slotSecondsRemaining).toBeGreaterThanOrEqual(0);
    expect(telem.ft8.slotSecondsRemaining).toBeLessThanOrEqual(15);
    expect(telem.ft8.totalDecodes).toBe(0);

    await runtime.stop();
  });

  it("generates pairing code and updates server telemetry", async () => {
    const runtime = new EdgeRuntime({ configPath, forceSimulated: true });
    await runtime.init();

    const { code, expiresAt } = runtime.generatePairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const telem = runtime.getTelemetry();
    expect(telem.server.activeCode).toBe(code);
    expect(telem.server.status).toBe("unpaired");
    expect(telem.server.codeExpiresInSec).toBeGreaterThan(0);

    await runtime.stop();
  });

  it("saves configuration and updates station details", async () => {
    const runtime = new EdgeRuntime({ configPath, forceSimulated: true });
    await runtime.init();

    await runtime.saveConfig({
      callsign: "W1AW",
      grid: "FN31pr",
      device: { id: 1, name: "USB Codec" },
      cat: { mode: "dummy", port: 4532 },
      cloudUrl: "ws://custom.cloud:8795"
    });

    const telem = runtime.getTelemetry();
    expect(telem.config.callsign).toBe("W1AW");
    expect(telem.config.grid).toBe("FN31PR");
    expect(telem.config.deviceId).toBe(1);
    expect(telem.config.catMode).toBe("dummy");
    expect(telem.config.cloudUrl).toBe("ws://custom.cloud:8795");
    expect(telem.config.isConfigured).toBe(true);

    await runtime.stop();
  });

  it("runs CAT test and PTT test in dummy/simulated mode safely", async () => {
    const runtime = new EdgeRuntime({ configPath, forceSimulated: true });
    await runtime.init();

    await runtime.saveConfig({ cat: { mode: "dummy", port: 4532 } });

    const catRes = await runtime.testCat();
    expect(catRes.ok).toBe(true);
    expect(catRes.catConnected).toBe(true);

    const pttRes = await runtime.testPtt(50);
    expect(pttRes.ok).toBe(true);

    await runtime.stop();
  });
});
