import type { TxSlot } from "./qso.js";

// FT8 transmits on a 15-second slot grid anchored to the unix epoch, so slot
// parity is a pure function of a timestamp. That is what makes a scalable
// virtual time base possible: scale the input and the whole system — decodes,
// countdowns, transmit scheduling — scales coherently with it.
export const FT8_SLOT_MS = 15_000;

// A scaled delay collapses toward zero wall time. This floor keeps a transmit
// from being scheduled sooner than the daemon can actually arm it.
export const MIN_WALL_DELAY_MS = 50;

export interface SlotClockSpec {
  // Virtual time at the anchor instant.
  epochMs: number;
  // The wall instant at which virtual time equalled epochMs. Two anchors are
  // required: a virtual reading is meaningless without the real-world moment it
  // was taken, the way a stopwatch reading is meaningless without a start time.
  anchorWallMs: number;
  slotMs: number;
  // Virtual milliseconds per wall millisecond. 1 is real time.
  scale: number;
}

// The real driver's clock: virtual time is wall time, so every clock-derived
// call collapses to the behavior digi-dx has today.
export function realtimeClockSpec(slotMs = FT8_SLOT_MS): SlotClockSpec {
  return { epochMs: 0, anchorWallMs: 0, slotMs, scale: 1 };
}

// The maximum scale at which a slot still has room for the floor at both ends.
export function maxUsableScale(slotMs = FT8_SLOT_MS, floorMs = MIN_WALL_DELAY_MS): number {
  return slotMs / (floorMs * 2);
}

// Owns the virtual time base and every slot computation. A real clock and a
// scaled one are the same type with different parameters — there is no separate
// mock, so the arithmetic under test is the arithmetic that ships.
//
// Units are pinned deliberately, because a seconds/milliseconds mix-up here is
// invisible and fatal: `now()` is virtual MILLISECONDS, `slotAt()` takes unix
// SECONDS (matching decode timestamps on the wire), and `secondsUntilSlot()`
// returns virtual SECONDS.
export class SlotClock {
  readonly spec: SlotClockSpec;
  private readonly wallNow: () => number;

  constructor(spec: SlotClockSpec, wallNow: () => number = Date.now) {
    if (!Number.isFinite(spec.scale) || spec.scale <= 0) {
      throw new Error(`slot clock scale must be a positive number, got ${spec.scale}`);
    }
    if (!Number.isFinite(spec.slotMs) || spec.slotMs <= 0) {
      throw new Error(`slot clock slotMs must be a positive number, got ${spec.slotMs}`);
    }

    // Reject the scale at construction rather than clamping delays at call time.
    // A silently clamped delay would push a transmit past its boundary into the
    // wrong parity slot — invisibly, in the very gate that is supposed to be
    // trustworthy. Failing loudly here is the cheaper mistake.
    const limit = maxUsableScale(spec.slotMs, MIN_WALL_DELAY_MS);
    if (spec.scale > limit) {
      throw new Error(
        `slot clock scale ${spec.scale} leaves no room for the ${MIN_WALL_DELAY_MS}ms floor ` +
          `in a ${spec.slotMs}ms slot; maximum usable scale is ${Math.floor(limit)}`
      );
    }

    this.spec = spec;
    this.wallNow = wallNow;
  }

  // Virtual milliseconds.
  now(): number {
    return this.spec.epochMs + (this.wallNow() - this.spec.anchorWallMs) * this.spec.scale;
  }

  // Convert a virtual duration into the wall duration it actually takes.
  toWallMs(virtualMs: number): number {
    return virtualMs / this.spec.scale;
  }

  private get slotSeconds(): number {
    return this.spec.slotMs / 1000;
  }

  // Takes unix SECONDS, matching decode timestamps on the wire.
  slotAt(tsSeconds: number): TxSlot {
    return Math.floor(tsSeconds / this.slotSeconds) % 2 === 0 ? "even" : "odd";
  }

  currentSlot(): TxSlot {
    return this.slotAt(Math.floor(this.now() / 1000));
  }

  // Virtual seconds until the given slot next opens. Always strictly positive:
  // standing exactly on a boundary means the next one, never this one.
  secondsUntilSlot(slot: TxSlot): number {
    const nowSeconds = Math.floor(this.now() / 1000);
    let nextStart = (Math.floor(nowSeconds / this.slotSeconds) + 1) * this.slotSeconds;
    while (this.slotAt(nextStart) !== slot) {
      nextStart += this.slotSeconds;
    }
    return nextStart - nowSeconds;
  }

  // Wall milliseconds to wait before acting on the given slot.
  //
  // `offsetVirtualSeconds` is SIGNED and is a virtual quantity, so it scales
  // with everything else. Positive fires early (the automation timer arms two
  // virtual seconds before the slot opens); negative fires late (the survey
  // waits a whole slot past the boundary plus a decode lag). Left unscaled,
  // either would land a full virtual slot out of position.
  wallDelayUntilSlot(slot: TxSlot, offsetVirtualSeconds = 0): number {
    const virtualSeconds = this.secondsUntilSlot(slot) - offsetVirtualSeconds;
    const wallMs = this.toWallMs(virtualSeconds * 1000);
    return Math.max(wallMs, MIN_WALL_DELAY_MS);
  }

  // A virtual instant in SECONDS, for a rendered countdown. The survey's end
  // time is a deadline rather than a delay, which wallDelayUntilSlot cannot
  // express.
  virtualDeadlineAfter(delayVirtualSeconds: number): number {
    return Math.floor(this.now() / 1000) + delayVirtualSeconds;
  }
}

export function slotClockFromSpec(spec: SlotClockSpec): SlotClock {
  return new SlotClock(spec);
}
