import { describe, expect, it } from "vitest";
import { TxState } from "../src/daemon/tx-state.js";

describe("TxState", () => {
  it("forwards pending same-slot and opposite-slot updates immediately", async () => {
    const writes: string[] = [];
    const tx = new TxState({ writeLine: (line) => {
      writes.push(line);
    } });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    await tx.transmit({ af: 1500, slot: "even", message: "K1ABC N1MPM FN33" });
    await tx.transmit({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" });

    expect(writes).toEqual(["1400E CQ N1MPM FN33", "1500E K1ABC N1MPM FN33", "1600O K1ABC N1MPM R-15"]);
    expect(tx.snapshot()).toEqual({
      state: "pending",
      af: 1600,
      slot: "odd",
      message: "K1ABC N1MPM R-15"
    });
  });

  it("updates active same-slot transmit without STOP", async () => {
    const writes: string[] = [];
    const tx = new TxState({ writeLine: (line) => {
      writes.push(line);
    } });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    tx.markEngineTx(true);
    await tx.transmit({ af: 1500, slot: "even", message: "K1ABC N1MPM FN33" });

    expect(writes).toEqual(["1400E CQ N1MPM FN33", "1500E K1ABC N1MPM FN33"]);
    expect(tx.snapshot().state).toBe("active");
  });

  it("stops active opposite-slot transmit before forwarding replacement", async () => {
    const writes: string[] = [];
    const tx = new TxState({ writeLine: (line) => {
      writes.push(line);
    }, stopTimeoutMs: 200 });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    tx.markEngineTx(true);
    const replacement = tx.transmit({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" });
    expect(writes).toEqual(["1400E CQ N1MPM FN33", "STOP"]);

    tx.markEngineTx(false);
    await replacement;
    expect(writes).toEqual(["1400E CQ N1MPM FN33", "STOP", "1600O K1ABC N1MPM R-15"]);
  });

  it("cancels pending or active transmit with STOP and idle update", async () => {
    const writes: string[] = [];
    const tx = new TxState({ writeLine: (line) => {
      writes.push(line);
    } });

    await tx.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    const update = await tx.cancel();

    expect(writes).toEqual(["1400E CQ N1MPM FN33", "STOP"]);
    expect(update).toMatchObject({ state: "idle", af: null, slot: null, message: null });
    expect(tx.snapshot().state).toBe("idle");
  });
});
