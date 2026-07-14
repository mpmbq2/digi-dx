import { describe, expect, it } from "vitest";
import { QsoAutomation, slotFromTimestamp, type DecodeRecord } from "../core/qso.js";
import { FT8_SLOT_MS, SlotClock, realtimeClockSpec } from "../core/slot-clock.js";
import {
  annotateDecode,
  buildActiveQsoView,
  buildCycleView,
  buildRosters,
  classifyKind,
  deriveTxCard,
  latestSlotAfs,
  senderOf
} from "../ui/web/view-model.js";

describe("web view-model helpers", () => {
  it("classifies replies, active QSOs, worked calls, and normal decodes", () => {
    const ctx = {
      myCall: "N1MPM",
      activeCallColors: new Map([["W1AW", "#34d3d3"]]),
      workedCalls: new Set(["K1ABC"])
    };

    expect(classifyKind("W1AW", "N1MPM W1AW FN31", ctx)).toEqual({ kind: "reply" });
    expect(classifyKind("W1AW", "CQ W1AW FN31", ctx)).toEqual({ kind: "qso", color: "#34d3d3" });
    expect(classifyKind("K1ABC", "CQ K1ABC FN42", ctx)).toEqual({ kind: "worked" });
    expect(classifyKind("N0CALL", "CQ N0CALL EM10", ctx)).toEqual({ kind: "normal" });
  });

  it("annotates decoded messages with sender, grid, and kind", () => {
    expect(senderOf("CQ W1AW FN31")).toBe("W1AW");
    expect(
      annotateDecode(decode("CQ W1AW FN31", 1_800_000_000, -10, 700), {
        myCall: "N1MPM",
        activeCallColors: new Map([["W1AW", "#34d3d3"]]),
        workedCalls: new Set()
      })
    ).toMatchObject({
      from: "W1AW",
      grid: "FN31",
      kind: "qso",
      color: "#34d3d3"
    });
  });

  it("builds parity rosters from the latest decode per station", () => {
    const rosters = buildRosters(
      [
        decode("CQ W1AW FN31", 1_800_000_000, -10, 700),
        decode("CQ W1AW FN31", 1_800_000_030, -5, 710),
        decode("CQ K1ABC FN42", 1_800_000_015, -20, 900)
      ],
      { myCall: "N1MPM", activeCallColors: new Map(), workedCalls: new Set(["K1ABC"]) },
      1_800_000_045_000
    );

    expect(rosters.even).toHaveLength(1);
    expect(rosters.even[0]).toMatchObject({ call: "W1AW", snr: -5, af: 710 });
    expect(rosters.odd[0]).toMatchObject({ call: "K1ABC", kind: "worked" });
  });

  it("returns occupied AFs from the latest cycle of a parity", () => {
    expect(
      latestSlotAfs(
        [
          decode("CQ OLD FN33", 1_799_999_970, -10, 500),
          decode("CQ W1AW FN31", 1_800_000_000, -10, 700),
          decode("CQ K1ABC FN42", 1_800_000_030, -10, 900)
        ],
        "even"
      )
    ).toEqual([900]);
  });

  it("builds active QSO cards and TX-card state from automation records", () => {
    const automation = new QsoAutomation(() => new Date("2026-07-08T12:00:00.000Z"));
    const qso = automation.createReplyToCall("W1AW", "N1MPM", "FN33", "odd", "FN31");
    const pending = automation.nextTransmission(1000)!;

    expect(buildActiveQsoView(automation.qsos, () => "#34d3d3", pending.qsoId, Date.parse("2026-07-08T12:00:05.000Z"))).toMatchObject([
      {
        id: qso.id,
        call: "W1AW",
        grid: "FN31",
        priority: 1,
        stepKey: "call-grid",
        nextTx: "W1AW N1MPM FN33",
        txing: true
      }
    ]);
    expect(deriveTxCard("pending", pending)).toEqual({
      txState: "pending",
      message: "W1AW N1MPM FN33",
      af: 1000,
      slot: "odd"
    });
  });
});

function decode(message: string, ts: number, snr: number, af: number): DecodeRecord {
  return { message, ts, snr, af, dt: 0.1 };
}

// The browser holds no clock and does no slot math -- it cannot import
// core/slot-clock.ts, and hand-porting the scale arithmetic into an untested,
// unbuilt script is the worst place for it. So the server resolves parity and
// the next boundary here, where the suite can actually reach them.
describe("buildCycleView", () => {
  const wallNow = 1_783_048_567_000;

  function scaledClock(scale: number, wallNowMs: number): SlotClock {
    return new SlotClock(
      { epochMs: 1_783_048_560_000, anchorWallMs: wallNowMs, slotMs: FT8_SLOT_MS, scale },
      () => wallNowMs
    );
  }

  it("reports no boundary before the daemon has published a clock", () => {
    // A neutral countdown, not a confidently wrong one.
    expect(buildCycleView(null, wallNow, wallNow)).toEqual({
      parity: slotFromTimestamp(Math.floor(wallNow / 1000)),
      nextBoundaryWallMs: null,
      slotWallMs: null,
      slotSeconds: null
    });
  });

  it("publishes the slot's wall duration, so the browser never needs the scale", () => {
    expect(buildCycleView(scaledClock(1, wallNow), wallNow, wallNow).slotWallMs).toBe(FT8_SLOT_MS);
    expect(buildCycleView(scaledClock(20, wallNow), wallNow, wallNow).slotWallMs).toBe(
      FT8_SLOT_MS / 20
    );
    // The FT8 slot length never changes -- an operator still reasons in 15s
    // cycles, whatever rate the engine runs at.
    expect(buildCycleView(scaledClock(20, wallNow), wallNow, wallNow).slotSeconds).toBe(15);
  });

  it("publishes the next boundary as a wall instant at scale 1", () => {
    const clock = new SlotClock(realtimeClockSpec(), () => wallNow);
    const view = buildCycleView(clock, wallNow, clock.now());

    expect(view.parity).toBe(slotFromTimestamp(Math.floor(wallNow / 1000)));
    // 1783048567 is 7s into a 15s slot, so the next boundary is 8s away.
    expect(view.nextBoundaryWallMs).toBe(wallNow + 8000);
  });

  it("scale-corrects the boundary, so a scaled band counts down faster", () => {
    // Covers AE1's server half: the browser subtracts wall instants, so the
    // scale correction has to be applied before it ever reaches the browser.
    const atOne = buildCycleView(scaledClock(1, wallNow), wallNow, scaledClock(1, wallNow).now());
    const atTwenty = buildCycleView(
      scaledClock(20, wallNow),
      wallNow,
      scaledClock(20, wallNow).now()
    );

    const wallMsAtOne = atOne.nextBoundaryWallMs! - wallNow;
    const wallMsAtTwenty = atTwenty.nextBoundaryWallMs! - wallNow;

    expect(wallMsAtOne).toBe(FT8_SLOT_MS);
    expect(wallMsAtTwenty).toBe(FT8_SLOT_MS / 20);
    expect(atOne.parity).toBe(atTwenty.parity);
  });

  it("agrees with the parity the decodes themselves carry", () => {
    const clock = scaledClock(20, wallNow);
    const view = buildCycleView(clock, wallNow, clock.now());
    const virtualNowSec = Math.floor(clock.now() / 1000);

    expect(view.parity).toBe(slotFromTimestamp(virtualNowSec));
  });
});

describe("annotateDecode slot metadata", () => {
  it("publishes each decode's slot and cycle start, so the browser derives neither", () => {
    const ctx = { myCall: "N1MPM", activeCallColors: new Map(), workedCalls: new Set<string>() };
    const view = annotateDecode(decode("CQ K1ABC FN42", 1_783_048_575, -8, 1200), ctx);

    expect(view.slot).toBe(slotFromTimestamp(1_783_048_575));
    expect(view.cycleStart).toBe(1_783_048_575);
  });

  it("keeps cycle start on the slot grid for a decode mid-cycle", () => {
    const ctx = { myCall: "N1MPM", activeCallColors: new Map(), workedCalls: new Set<string>() };
    const view = annotateDecode(decode("CQ K1ABC FN42", 1_783_048_581, -8, 1200), ctx);

    expect(view.cycleStart).toBe(1_783_048_575);
    expect(view.slot).toBe(slotFromTimestamp(1_783_048_575));
  });
});
