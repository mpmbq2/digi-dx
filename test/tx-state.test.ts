import { describe, expect, it } from "vitest";
import { TxState } from "../src/daemon/tx-state.js";

describe("TxState", () => {
  it("forwards pending same-slot and opposite-slot updates immediately", async () => {
    const transmits: Array<{ af: number; slot: "even" | "odd"; message: string }> = [];
    const tx = new TxState({
      transmit: (intent) => {
        transmits.push(intent);
      },
      cancelTransmit: () => undefined
    });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    await tx.transmit({ af: 1500, slot: "even", message: "K1ABC N1MPM FN33" });
    await tx.transmit({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" });

    expect(transmits).toEqual([
      { af: 1400, slot: "even", message: "CQ N1MPM FN33" },
      { af: 1500, slot: "even", message: "K1ABC N1MPM FN33" },
      { af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" }
    ]);
    expect(tx.snapshot()).toEqual({
      state: "pending",
      af: 1600,
      slot: "odd",
      message: "K1ABC N1MPM R-15"
    });
  });

  it("updates active same-slot transmit without STOP", async () => {
    const transmits: Array<{ af: number; slot: "even" | "odd"; message: string }> = [];
    let stops = 0;
    const tx = new TxState({
      transmit: (intent) => {
        transmits.push(intent);
      },
      cancelTransmit: () => {
        stops += 1;
      }
    });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    tx.markEngineTx(true);
    await tx.transmit({ af: 1500, slot: "even", message: "K1ABC N1MPM FN33" });

    expect(stops).toBe(0);
    expect(transmits).toEqual([
      { af: 1400, slot: "even", message: "CQ N1MPM FN33" },
      { af: 1500, slot: "even", message: "K1ABC N1MPM FN33" }
    ]);
    expect(tx.snapshot().state).toBe("active");
  });

  it("stops active opposite-slot transmit before forwarding replacement", async () => {
    const transmits: Array<{ af: number; slot: "even" | "odd"; message: string }> = [];
    let stops = 0;
    const tx = new TxState({
      transmit: (intent) => {
        transmits.push(intent);
      },
      cancelTransmit: () => {
        stops += 1;
      },
      stopTimeoutMs: 200
    });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    tx.markEngineTx(true);
    const replacement = tx.transmit({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" });
    expect(stops).toBe(1);
    expect(transmits).toEqual([{ af: 1400, slot: "even", message: "CQ N1MPM FN33" }]);

    tx.markEngineTx(false);
    await replacement;
    expect(transmits).toEqual([
      { af: 1400, slot: "even", message: "CQ N1MPM FN33" },
      { af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" }
    ]);
  });

  it("cancels pending or active transmit with STOP and idle update", async () => {
    let stops = 0;
    const tx = new TxState({
      transmit: () => undefined,
      cancelTransmit: () => {
        stops += 1;
      }
    });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    const update = await tx.cancel();

    expect(stops).toBe(1);
    expect(update).toMatchObject({ state: "idle", af: null, slot: null, message: null });
    expect(tx.snapshot().state).toBe("idle");
  });
});
