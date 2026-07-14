import { describe, expect, it } from "vitest";
import { FT8_SLOT_MS } from "../core/slot-clock.js";
import type { SessionConfig } from "../src/daemon/config.js";
import { SimulatedDriver, resolveSimOptions } from "../src/daemon/simulated-driver.js";
import type { SimRoster } from "../src/daemon/sim-station.js";

const session: SessionConfig = {
  mode: "FT8",
  device: { id: 99, name: "Simulated Rig" },
  callsign: "N1MPM",
  grid: "FN33",
  cat: { mode: "dummy", port: 4532 }
};

// A one-station band whose caller opens with a directed call, so the exchange
// runs with no human in the loop.
const soloRoster: SimRoster = {
  operatorCall: "N1MPM",
  operatorGrid: "FN33",
  stations: [
    { call: "QQ1ABC", grid: "FN42", af: 1200, snr: -8, slot: "even", behavior: "calls-operator" }
  ]
};

// The band runs on the driver's own virtual clock, driven by real timers. At a
// high scale a slot is milliseconds of wall time, so a whole QSO plays out
// inside a test without faking timers -- which is the same property that lets a
// cloud agent verify a QSO in seconds instead of ninety.
async function collect(
  driver: SimulatedDriver,
  slots: number,
  scale: number,
  onDecode?: (message: string) => void
): Promise<{ decodes: string[]; txs: string[]; ptt: boolean[] }> {
  const decodes: string[] = [];
  const txs: string[] = [];
  const ptt: boolean[] = [];

  driver.on("decode", (decode) => {
    decodes.push(decode.message);
    onDecode?.(decode.message);
  });
  driver.on("tx", (tx) => txs.push(tx.message));
  driver.on("ptt", (active) => ptt.push(active));

  await driver.start(session);
  const wallMsPerSlot = FT8_SLOT_MS / scale;
  await new Promise((resolve) => setTimeout(resolve, wallMsPerSlot * slots + 40));
  await driver.stop();

  return { decodes, txs, ptt };
}

describe("SimulatedDriver", () => {
  it("touches no hardware", async () => {
    // The whole point: no audio device, no engine process, no CAT. Prove it by
    // handing it a session that no real driver could survive -- a device id that
    // does not exist and a CAT port nothing is listening on -- and watching the
    // band come up anyway. The real driver throws SOUND_DEVICE_UNAVAILABLE and
    // CAT_FAILED on exactly this input.
    const impossible: SessionConfig = {
      ...session,
      device: { id: 31337, name: "No Such Device" },
      cat: { mode: "rigctld", port: 1 }
    };
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const decodes: string[] = [];
    driver.on("decode", (decode) => decodes.push(decode.message));

    await expect(driver.start(impossible)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 2 + 40));
    await driver.stop();

    expect(decodes.length).toBeGreaterThan(0);
  });

  it("reports itself as the simulated engine", () => {
    expect(new SimulatedDriver().kind).toBe("simulated");
  });

  it("defaults to real-time scale so interactive demo mode is not strobing", () => {
    expect(new SimulatedDriver().clock().scale).toBe(1);
  });

  it("publishes a scaled clock anchored on a slot boundary", () => {
    const driver = new SimulatedDriver({ scale: 20 });
    const spec = driver.clock();

    expect(spec.scale).toBe(20);
    expect(spec.slotMs).toBe(FT8_SLOT_MS);
    expect(spec.epochMs % FT8_SLOT_MS).toBe(0);
    // Present-day, not 1970 -- the anchor is what keeps virtual time realistic.
    expect(spec.epochMs).toBeGreaterThan(1_700_000_000_000);
  });

  it("offers a fabricated audio device, so first-run setup has something to show", async () => {
    const devices = await new SimulatedDriver().listAudioDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.name).toBe("Simulated Rig");
  });

  it("puts a station on the air calling the operator", async () => {
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const { decodes } = await collect(driver, 2, 100);

    expect(decodes[0]).toBe("N1MPM QQ1ABC FN42");
  });

  it("emits decodes on slot boundaries in its own time base", async () => {
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const stamps: number[] = [];
    driver.on("decode", (decode) => stamps.push(decode.ts));

    await driver.start(session);
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 3 + 40));
    await driver.stop();

    expect(stamps.length).toBeGreaterThan(0);
    for (const ts of stamps) {
      expect(ts % (FT8_SLOT_MS / 1000)).toBe(0);
    }
  });

  it("only keys PTT on the slot the transmit asked for", async () => {
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const txs: string[] = [];
    const ptts: boolean[] = [];
    driver.on("tx", (tx) => txs.push(tx.message));
    driver.on("ptt", (active) => ptts.push(active));

    await driver.start(session);
    await driver.transmit({ af: 1500, slot: "odd", message: "QQ1ABC N1MPM -08" });
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 3 + 40));
    await driver.stop();

    expect(txs).toContain("QQ1ABC N1MPM -08");
    expect(ptts).toContain(true);
    expect(ptts).toContain(false);
  });

  it("cancelTransmit drops the queued message and the key", async () => {
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const txs: string[] = [];
    driver.on("tx", (tx) => txs.push(tx.message));

    await driver.start(session);
    await driver.transmit({ af: 1500, slot: "odd", message: "QQ1ABC N1MPM -08" });
    await driver.cancelTransmit();
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 3 + 40));
    await driver.stop();

    expect(txs).not.toContain("QQ1ABC N1MPM -08");
  });

  it("carries a QSO to completion when the operator answers", async () => {
    // The band actually reacts to what we transmit. This is the property that
    // makes the whole verification path work: a scripted tape could not do it.
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const decodes: string[] = [];

    driver.on("decode", (decode) => {
      decodes.push(decode.message);
      // Play the operator's side by hand, exactly as the client would.
      if (decode.message === "N1MPM QQ1ABC FN42") {
        void driver.transmit({ af: 1500, slot: "odd", message: "QQ1ABC N1MPM -08" });
      }
      if (decode.message.startsWith("N1MPM QQ1ABC R")) {
        void driver.transmit({ af: 1500, slot: "odd", message: "QQ1ABC N1MPM RR73" });
      }
    });

    await driver.start(session);
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 10 + 60));
    await driver.stop();

    expect(decodes).toContain("N1MPM QQ1ABC FN42");
    expect(decodes).toContain("N1MPM QQ1ABC R-08");
    expect(decodes).toContain("N1MPM QQ1ABC 73");
  });

  it("stops cleanly and puts nothing else on the air", async () => {
    const driver = new SimulatedDriver({ scale: 100, roster: soloRoster });
    const decodes: string[] = [];
    driver.on("decode", (decode) => decodes.push(decode.message));

    await driver.start(session);
    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 2));
    await driver.stop();
    const afterStop = decodes.length;

    await new Promise((resolve) => setTimeout(resolve, (FT8_SLOT_MS / 100) * 3));
    expect(decodes).toHaveLength(afterStop);
  });
});

describe("resolveSimOptions", () => {
  it("defaults to real time, because a sped-up band looks wrong to an operator", () => {
    expect(resolveSimOptions({})).toEqual({ scale: 1, seed: 1 });
  });

  it("reads the scale and seed from the environment", () => {
    expect(resolveSimOptions({ DIGI_DX_SIM_SCALE: "20", DIGI_DX_SIM_SEED: "7" })).toEqual({
      scale: 20,
      seed: 7
    });
  });

  it("rejects a scale the slot clock cannot honor, naming the limit", () => {
    expect(() => resolveSimOptions({ DIGI_DX_SIM_SCALE: "1000" })).toThrowError(/maximum usable/i);
  });

  it("rejects a nonsense scale rather than silently running at 1", () => {
    expect(() => resolveSimOptions({ DIGI_DX_SIM_SCALE: "0" })).toThrow();
    expect(() => resolveSimOptions({ DIGI_DX_SIM_SCALE: "-5" })).toThrow();
  });
});
