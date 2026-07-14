/**
 * Pure helpers for AE1: assert the rendered cycle countdown agrees with the
 * daemon-published wall deadline at a capture instant.
 */

export interface PublishedCycle {
  parity: "even" | "odd" | string;
  nextBoundaryWallMs: number | null;
  slotWallMs: number | null;
  slotSeconds: number | null;
}

export interface ParsedCycleDisplay {
  parity: "even" | "odd";
  remainingSeconds: number;
}

/** Match "EVEN · t-12.3" / "ODD · t-0.5" as rendered by ui/web/public/app.js. */
export function parseCycleCountdown(text: string): ParsedCycleDisplay | null {
  const match = text.trim().match(/^(EVEN|ODD)\s*·\s*t-(\d+(?:\.\d+)?)$/i);
  if (!match) {
    return null;
  }
  return {
    parity: match[1]!.toLowerCase() as "even" | "odd",
    remainingSeconds: Number(match[2])
  };
}

/**
 * Same formula the browser uses in renderClockAndNow: remaining wall time to
 * the published deadline, expressed in FT8 slot-seconds.
 */
export function expectedFt8CountdownSeconds(
  cycle: PublishedCycle,
  nowMs: number
): number | null {
  if (
    cycle.nextBoundaryWallMs === null ||
    !cycle.slotWallMs ||
    cycle.slotSeconds === null
  ) {
    return null;
  }
  const remainingWallMs = Math.max(0, cycle.nextBoundaryWallMs - nowMs);
  return (remainingWallMs / cycle.slotWallMs) * cycle.slotSeconds;
}

export interface CountdownAgreementOptions {
  /** FT8-seconds tolerance; default covers the browser's 200ms tick + rounding. */
  toleranceFt8Seconds?: number;
  nowMs: number;
}

export function assertCountdownAgrees(
  displayedText: string,
  cycle: PublishedCycle,
  options: CountdownAgreementOptions
): void {
  const parsed = parseCycleCountdown(displayedText);
  if (!parsed) {
    throw new Error(
      `countdown assertion failed: could not parse cycle display ${JSON.stringify(displayedText)}`
    );
  }
  if (cycle.parity && parsed.parity !== cycle.parity.toLowerCase()) {
    throw new Error(
      `countdown assertion failed: displayed parity ${parsed.parity} !== published ${cycle.parity}`
    );
  }
  const expected = expectedFt8CountdownSeconds(cycle, options.nowMs);
  if (expected === null) {
    throw new Error("countdown assertion failed: published cycle has no boundary yet");
  }
  const tolerance = options.toleranceFt8Seconds ?? 0.5;
  const delta = Math.abs(parsed.remainingSeconds - expected);
  if (delta > tolerance) {
    throw new Error(
      `countdown assertion failed: displayed t-${parsed.remainingSeconds.toFixed(1)} ` +
        `disagrees with published clock t-${expected.toFixed(1)} ` +
        `(Δ=${delta.toFixed(2)}s > ${tolerance}s)`
    );
  }
}
