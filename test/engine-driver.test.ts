import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../src/daemon/config.js";
import { Engine } from "../src/daemon/engine.js";
import type { DriverDecode, EngineDriver, EngineDriverEvents } from "../src/daemon/engine-driver.js";
import type { AudioDevice } from "../src/daemon/audio-devices.js";
import type { TxIntent } from "../src/daemon/protocol.js";

class FakeEngineDriver extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  started = false;
  stopped = false;
  transmitted: TxIntent[] = [];
  cancelCount = 0;
  session: SessionConfig | null = null;

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
  it("starts active and emits decode events", async () => {
    const driver = new FakeEngineDriver();
    const engine = new Engine({ driver });
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
    const engine = new Engine({ driver });
    await engine.start(session);

    const intent = { af: 1400, slot: "even" as const, message: "CQ N1MPM FN33" };
    await engine.transmit(intent);
    expect(driver.transmitted).toEqual([intent]);
  });

  it("stops and returns to inactive", async () => {
    const driver = new FakeEngineDriver();
    const engine = new Engine({ driver });
    await engine.start(session);
    await engine.stop();

    expect(driver.stopped).toBe(true);
    expect(engine.snapshot().state).toBe("inactive");
  });

  it("emits PROCESS_CRASHED on driver crash", async () => {
    const driver = new FakeEngineDriver();
    const engine = new Engine({ driver });
    const errors: unknown[] = [];
    engine.on("error", (error) => errors.push(error));

    await engine.start(session);
    driver.crash();
    await new Promise((resolve) => setImmediate(resolve));

    expect(engine.snapshot().state).toBe("inactive");
    expect(errors[0]).toMatchObject({ code: "PROCESS_CRASHED" });
  });

  it("cancels opposite-slot transmit via driver cancelTransmit", async () => {
    const driver = new FakeEngineDriver();
    const engine = new Engine({ driver });
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
