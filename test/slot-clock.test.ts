import { describe, expect, it } from "vitest";
import { slotFromTimestamp, secondsUntilNextSlot } from "../core/qso.js";
import {
  FT8_SLOT_MS,
  MIN_WALL_DELAY_MS,
  SlotClock,
  realtimeClockSpec,
  type SlotClockSpec
} from "../core/slot-clock.js";

// A wall-anchored, scale-1 clock must be behaviorally identical to the slot
// helpers in core/qso.ts. Every other test leans on that equivalence.
function realtime(nowMs = Date.now()): SlotClock {
  return new SlotClock(realtimeClockSpec(), () => nowMs);
}

function scaled(scale: number, anchorWallMs = 1_000_000, nowMs = anchorWallMs): SlotClock {
  const spec: SlotClockSpec = {
    epochMs: 1_783_000_000_000,
    anchorWallMs,
    slotMs: FT8_SLOT_MS,
    scale
  };
  return new SlotClock(spec, () => nowMs);
}

describe("SlotClock at scale 1", () => {
  it("returns the same parity as slotFromTimestamp", () => {
    const clock = realtime();
    for (const ts of [0, 7, 14, 15, 22, 29, 30, 1_783_048_560, 1_783_048_575]) {
      expect(clock.slotAt(ts)).toBe(slotFromTimestamp(ts));
    }
  });

  it("matches secondsUntilNextSlot across a full 30-second sweep", () => {
    const base = 1_783_048_560_000;
    for (let step = 0; step < 30; step += 1) {
      const nowMs = base + step * 1000;
      const clock = realtime(nowMs);
      for (const slot of ["even", "odd"] as const) {
        expect(clock.secondsUntilSlot(slot)).toBe(secondsUntilNextSlot(slot, nowMs));
      }
    }
  });

  it("keeps virtual time equal to wall time", () => {
    const nowMs = 1_783_048_567_123;
    expect(realtime(nowMs).now()).toBe(nowMs);
  });
});

describe("SlotClock scaling", () => {
  it("advances virtual time by the scale factor", () => {
    const anchor = 1_000_000;
    const clock = scaled(20, anchor, anchor + 1000);
    // One wall second at 20x is twenty virtual seconds past the epoch.
    expect(clock.now()).toBe(1_783_000_000_000 + 20_000);
  });

  it("converts a virtual slot into a scaled wall delay", () => {
    expect(scaled(20).toWallMs(FT8_SLOT_MS)).toBe(750);
    expect(scaled(1).toWallMs(FT8_SLOT_MS)).toBe(FT8_SLOT_MS);
  });

  it("computes parity independently of scale", () => {
    const ts = 1_783_048_575;
    expect(scaled(1).slotAt(ts)).toBe(scaled(20).slotAt(ts));
    expect(scaled(20).slotAt(ts)).toBe(slotFromTimestamp(ts));
  });

  it("keeps virtual timestamps in the present day at any scale", () => {
    // Re-anchoring on the consumer's own wall clock would drag virtual time
    // toward 1970; the anchor is what prevents it.
    const nowSec = Math.floor(scaled(20, 1_000_000, 1_030_000).now() / 1000);
    expect(nowSec).toBeGreaterThan(1_700_000_000);
  });
});

describe("SlotClock.wallDelayUntilSlot", () => {
  it("applies a positive offset as a virtual lead at any scale", () => {
    // The automation timer fires two virtual seconds before the slot opens.
    const at = (scale: number) => {
      const anchorWall = 1_000_000;
      const clock = scaled(scale, anchorWall, anchorWall);
      const virtualLead = clock.secondsUntilSlot("even") - 2;
      return { actual: clock.wallDelayUntilSlot("even", 2), expected: (virtualLead * 1000) / scale };
    };

    for (const scale of [1, 20]) {
      const { actual, expected } = at(scale);
      expect(actual).toBeCloseTo(Math.max(expected, MIN_WALL_DELAY_MS), 5);
    }
  });

  it("resolves a negative offset — the survey waits past the boundary", () => {
    // The survey holds TX for one whole slot past the boundary plus a decode
    // lag. The slot length comes from slotMs, never a literal 15.
    const lagSeconds = 2;
    for (const scale of [1, 20]) {
      const anchorWall = 1_000_000;
      const clock = scaled(scale, anchorWall, anchorWall);
      const slotSeconds = FT8_SLOT_MS / 1000;
      const offset = -(slotSeconds + lagSeconds);

      const expectedVirtual = clock.secondsUntilSlot("odd") + slotSeconds + lagSeconds;
      expect(clock.wallDelayUntilSlot("odd", offset)).toBeCloseTo((expectedVirtual * 1000) / scale, 5);
    }
  });

  it("never returns a delay below the floor", () => {
    const clock = scaled(20);
    expect(clock.wallDelayUntilSlot("even", 999)).toBe(MIN_WALL_DELAY_MS);
  });

  it("keeps a floored delay inside the requested slot", () => {
    // The construction guard is what makes this true: a floor that could push
    // a transmit past its boundary is rejected before it can happen.
    const clock = scaled(20);
    const slotWallMs = FT8_SLOT_MS / 20;
    expect(MIN_WALL_DELAY_MS).toBeLessThan(slotWallMs / 2);
    expect(clock.wallDelayUntilSlot("even", 999)).toBeLessThan(slotWallMs);
  });
});

describe("SlotClock construction guard", () => {
  it("rejects a scale whose slot window cannot honor the floor", () => {
    expect(() => scaled(500)).toThrowError(/scale/i);
  });

  it("names the maximum usable scale when it rejects", () => {
    const maxScale = FT8_SLOT_MS / (MIN_WALL_DELAY_MS * 2);
    expect(() => scaled(maxScale + 1)).toThrowError(new RegExp(String(Math.floor(maxScale))));
  });

  it("accepts the maximum usable scale", () => {
    const maxScale = FT8_SLOT_MS / (MIN_WALL_DELAY_MS * 2);
    expect(() => scaled(maxScale)).not.toThrow();
  });

  it("rejects a non-positive scale", () => {
    expect(() => scaled(0)).toThrow();
    expect(() => scaled(-1)).toThrow();
  });
});

describe("SlotClock.virtualDeadlineAfter", () => {
  it("returns a virtual instant in seconds, for a rendered countdown", () => {
    // surveyEndSec is a deadline, not a delay — wallDelayUntilSlot cannot
    // express it, so the clock offers this separately.
    const clock = scaled(20);
    const nowSec = Math.floor(clock.now() / 1000);
    expect(clock.virtualDeadlineAfter(17)).toBe(nowSec + 17);
  });
});

describe("SlotClock boundary determinism", () => {
  it("resolves the exact transition instant without float drift", () => {
    // 1783048575 is a slot boundary; parity must not depend on rounding.
    expect(realtime().slotAt(1_783_048_575)).toBe(slotFromTimestamp(1_783_048_575));
    expect(realtime().slotAt(1_783_048_574)).toBe(slotFromTimestamp(1_783_048_574));
  });

  it("never returns zero seconds until a slot — always the next boundary", () => {
    const onBoundaryMs = 1_783_048_575_000;
    const clock = realtime(onBoundaryMs);
    expect(clock.secondsUntilSlot("even")).toBeGreaterThan(0);
    expect(clock.secondsUntilSlot("odd")).toBeGreaterThan(0);
  });
});
