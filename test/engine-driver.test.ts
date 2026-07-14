import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FT8_SLOT_MS, realtimeClockSpec } from "../core/slot-clock.js";
import type { SessionConfig } from "../src/daemon/config.js";
import { Engine, statusFromSnapshot } from "../src/daemon/engine.js";
import type { DriverDecode, EngineDriver, EngineDriverEvents } from "../src/daemon/engine-driver.js";
import type { AudioDevice } from "../src/daemon/audio-devices.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "../src/daemon/protocol.js";

class FakeEngineDriver extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  started = false;
  stopped = false;
  transmitted: TxIntent[] = [];
  cancelCount = 0;
  session: SessionConfig | null = null;
  readonly kind: EngineKind;
  private readonly spec: SlotClockSpec;

  constructor(kind: EngineKind = "ft8cat", spec: SlotClockSpec = realtimeClockSpec()) {
    super();
    this.kind = kind;
    this.spec = spec;
  }

  clock(): SlotClockSpec {
    return this.spec;
  }

  async start(session: SessionConfig): Promise<void> {
    this.started = true;
    this.session = session;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
  }

  async transmit(intent: TxIntent): Promise<void> {
    this.transmitted.push(intent);
  }

  async cancelTransmit(): Promise<void> {
    this.cancelCount += 1;
  }

  async listAudioDevices(): Promise<AudioDevice[]> {
    return [{ id: 1, name: "test", inputs: 0, outputs: 0 }];
  }

  injectDecode(decode: DriverDecode): void {
    this.emit("decode", decode);
  }

  crash(): void {
    this.emit("crash", new Error("simulated crash"));
  }

  ptt(active: boolean): void {
    this.emit("ptt", active);
  }
}

const session: SessionConfig = {
  mode: "FT8",
  device: { id: 1, name: "test" },
  callsign: "N1MPM",
  grid: "FN33",
  cat: { mode: "dummy", port: 4532 }
};

describe("Engine with fake driver", () => {
  function makeEngine(driver: FakeEngineDriver): Engine {
    return new Engine({ driver, simulatedDriver: new FakeEngineDriver("simulated") });
  }

  it("starts active and emits decode events", async () => {
    const driver = new FakeEngineDriver();
    const engine = makeEngine(driver);
    const events: unknown[] = [];
    engine.on("event", (event) => events.push(event));

    await engine.start(session);
    expect(engine.snapshot().state).toBe("active");
    expect(driver.started).toBe(true);

    driver.injectDecode({
      ts: 1783048560,
      snr: 10,
      dt: -0.6,
      af: 2024,
      mode: "FT8",
      message: "WM8Q DL0EO -17"
    });

    expect(events).toContainEqual({
      type: "decode",
      ts: 1783048560,
      snr: 10,
      dt: -0.6,
      af: 2024,
      mode: "FT8",
      message: "WM8Q DL0EO -17"
    });
  });

  it("forwards transmit intents to the driver", async () => {
    const driver = new FakeEngineDriver();
    const engine = makeEngine(driver);
    await engine.start(session);

    const intent = { af: 1400, slot: "even" as const, message: "CQ N1MPM FN33" };
    await engine.transmit(intent);
    expect(driver.transmitted).toEqual([intent]);
  });

  it("stops and returns to inactive on the real driver", async () => {
    const driver = new FakeEngineDriver();
    const sim = new FakeEngineDriver("simulated");
    const engine = new Engine({ driver, simulatedDriver: sim });
    await engine.start(session, "simulated");
    expect(engine.snapshot().engine).toBe("simulated");
    await engine.stop();

    expect(sim.stopped).toBe(true);
    expect(engine.snapshot().state).toBe("inactive");
    expect(engine.snapshot().engine).toBe("ft8cat");
  });

  it("refuses to alias the simulated driver onto the real radio", () => {
    const driver = new FakeEngineDriver();
    expect(() => new Engine({ driver, simulatedDriver: driver })).toThrow(/distinct simulatedDriver/);
  });

  it("emits PROCESS_CRASHED on driver crash", async () => {
    const driver = new FakeEngineDriver();
    const engine = makeEngine(driver);
    const errors: unknown[] = [];
    engine.on("error", (error) => errors.push(error));

    await engine.start(session);
    driver.crash();
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.snapshot().state).toBe("inactive");
    expect(errors[0]).toMatchObject({ code: "PROCESS_CRASHED" });
  });

  it("publishes the driver's kind and clock on the wire status", async () => {
    const driver = new FakeEngineDriver();
    const engine = makeEngine(driver);
    await engine.start(session);

    const status = statusFromSnapshot(engine.snapshot(), { held: false, byThisClient: false });
    expect(status.engine).toBe("ft8cat");
    expect(status.clock).toEqual({ epochMs: 0, anchorWallMs: 0, slotMs: FT8_SLOT_MS, scale: 1 });
  });

  it("reports a scaled driver's clock unchanged", async () => {
    const spec: SlotClockSpec = {
      epochMs: 1_783_000_000_000,
      anchorWallMs: 1_000_000,
      slotMs: FT8_SLOT_MS,
      scale: 20
    };
    const driver = new FakeEngineDriver("simulated", spec);
    const engine = makeEngine(driver);
    await engine.start(session);

    const status = statusFromSnapshot(engine.snapshot(), { held: false, byThisClient: false });
    expect(status.engine).toBe("simulated");
    expect(status.clock).toEqual(spec);
  });

  it("stamps tx_update in the driver's time base, in seconds not milliseconds", async () => {
    // TxStateOptions.now is unix seconds; SlotClock.now() is virtual
    // milliseconds. Wiring the clock straight through would multiply every
    // tx_update timestamp by a thousand, silently, on the wire.
    const spec: SlotClockSpec = {
      epochMs: 1_783_000_000_000,
      anchorWallMs: Date.now(),
      slotMs: FT8_SLOT_MS,
      scale: 20
    };
    const driver = new FakeEngineDriver("simulated", spec);
    const engine = makeEngine(driver);
    const events: Array<{ type: string; ts: number }> = [];
    engine.on("event", (event) => events.push(event as { type: string; ts: number }));

    await engine.start(session);
    await engine.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });

    const update = events.find((event) => event.type === "tx_update");
    expect(update).toBeDefined();
    // Virtual epoch is ~1.783e12 ms, i.e. ~1.783e9 seconds. A milliseconds leak
    // would be three orders of magnitude larger than any plausible unix second.
    expect(update?.ts).toBeGreaterThan(1_700_000_000);
    expect(update?.ts).toBeLessThan(2_000_000_000);
  });

  it("cancels opposite-slot transmit via driver cancelTransmit", async () => {
    const driver = new FakeEngineDriver();
    const engine = makeEngine(driver);
    await engine.start(session);

    await engine.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    driver.ptt(true);
    await engine.transmit({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" });

    expect(driver.cancelCount).toBe(1);
    expect(driver.transmitted).toEqual([
      { af: 1400, slot: "even", message: "CQ N1MPM FN33" },
      { af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" }
    ]);
  });
});
