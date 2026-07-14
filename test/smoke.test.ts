import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExpectedDemoQso,
  SmokeFailure,
  waitForDemoQsoEntry
} from "../scripts/smoke-assert.js";
import {
  NO_MERGE_BASE_MESSAGE,
  NOT_INDEPENDENT_BANNER,
  classifyWatchedChanges,
  evaluateIndependence
} from "../scripts/smoke-independence.js";
import {
  assertCountdownAgrees,
  expectedFt8CountdownSeconds,
  parseCycleCountdown
} from "../scripts/smoke-ui-countdown.js";
import type { QsoLogEntry } from "../core/qso.js";

describe("smoke independence (R17)", () => {
  it("fails closed when there is no merge base", () => {
    const result = evaluateIndependence({ mergeBase: null, changedPaths: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(NO_MERGE_BASE_MESSAGE);
    expect(result.banner).toBeNull();
  });

  it("banners when a watched path is in the changed set", () => {
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: ["docs/install.md", "src/daemon/sim-station.ts", "README.md"]
    });
    expect(result.ok).toBe(true);
    expect(result.banner).toBe(NOT_INDEPENDENT_BANNER);
    expect(result.touchedWatched).toEqual(["src/daemon/sim-station.ts"]);
  });

  it("banners when smoke scripts themselves change", () => {
    const touched = classifyWatchedChanges([
      "scripts/smoke.ts",
      "scripts/smoke-ui.ts",
      "scripts/smoke-independence.ts"
    ]);
    expect(touched).toEqual([
      "scripts/smoke-independence.ts",
      "scripts/smoke-ui.ts",
      "scripts/smoke.ts"
    ]);
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: touched
    });
    expect(result.banner).toBe(NOT_INDEPENDENT_BANNER);
  });

  it("banners when client automation paths change", () => {
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: ["core/qso.ts", "ui/web/server.ts", "ui/qso-log.ts"]
    });
    expect(result.banner).toBe(NOT_INDEPENDENT_BANNER);
    expect(result.touchedWatched).toEqual(["core/qso.ts", "ui/qso-log.ts", "ui/web/server.ts"]);
  });

  it("produces no banner when watched paths are untouched", () => {
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: ["docs/install.md", "docs/protocol.md"]
    });
    expect(result.ok).toBe(true);
    expect(result.banner).toBeNull();
    expect(result.touchedWatched).toEqual([]);
  });
});

describe("smoke demo-log wait (AE4)", () => {
  it("fails loudly when no QSO appears within the timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-smoke-"));
    const path = join(dir, "demo-qso-log.jsonl");
    await writeFile(path, "", "utf8");

    await expect(waitForDemoQsoEntry(path, { timeoutMs: 150, pollMs: 40 })).rejects.toThrow(
      /smoke failed: no QSO logged/
    );
  });

  it("returns the first entry once logged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-smoke-"));
    const path = join(dir, "demo-qso-log.jsonl");
    const entry = sampleEntry();
    setTimeout(() => {
      void writeFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    }, 80);

    const got = await waitForDemoQsoEntry(path, { timeoutMs: 2000, pollMs: 20 });
    expect(got.theirCall).toBe("QQ1ABC");
  });

  it("rejects a QSO that is not demo-shaped", () => {
    expect(() =>
      assertExpectedDemoQso({
        ...sampleEntry(),
        myCall: "N1MPM"
      })
    ).toThrow(SmokeFailure);
  });
});

describe("smoke-ui countdown (AE1)", () => {
  it("parses the cycle display text", () => {
    expect(parseCycleCountdown("EVEN · t-12.3")).toEqual({
      parity: "even",
      remainingSeconds: 12.3
    });
    expect(parseCycleCountdown("ODD · t-0.5")).toEqual({
      parity: "odd",
      remainingSeconds: 0.5
    });
    expect(parseCycleCountdown("--")).toBeNull();
  });

  it("recomputes FT8 countdown from the published wall deadline", () => {
    const cycle = {
      parity: "even" as const,
      nextBoundaryWallMs: 1_000_750,
      slotWallMs: 750,
      slotSeconds: 15
    };
    // Halfway through a scaled slot → 7.5 FT8 seconds remaining.
    expect(expectedFt8CountdownSeconds(cycle, 1_000_375)).toBe(7.5);
  });

  it("accepts a display that matches the published clock", () => {
    const cycle = {
      parity: "odd" as const,
      nextBoundaryWallMs: 2_000_000,
      slotWallMs: 750,
      slotSeconds: 15
    };
    const nowMs = 2_000_000 - 375;
    expect(() =>
      assertCountdownAgrees("ODD · t-7.5", cycle, { nowMs, toleranceFt8Seconds: 0.1 })
    ).not.toThrow();
  });

  it("rejects a desynchronized countdown", () => {
    const cycle = {
      parity: "even" as const,
      nextBoundaryWallMs: 1_000_750,
      slotWallMs: 750,
      slotSeconds: 15
    };
    expect(() =>
      assertCountdownAgrees("EVEN · t-1.0", cycle, {
        nowMs: 1_000_375,
        toleranceFt8Seconds: 0.5
      })
    ).toThrow(/disagrees with published clock/);
  });
});

function sampleEntry(): QsoLogEntry {
  return {
    completedAt: "2026-07-14T12:00:00.000Z",
    startedAt: "2026-07-14T11:59:00.000Z",
    myCall: "QQ0DEMO",
    myGrid: "FN42",
    theirCall: "QQ1ABC",
    theirGrid: "FN31",
    sentReport: "-07",
    receivedReport: "-12",
    txMessages: [{ ts: 1, af: 800, message: "QQ1ABC QQ0DEMO FN42" }],
    rxMessages: [{ ts: 2, af: 800, message: "QQ0DEMO QQ1ABC -12" }],
    reason: "rr73"
  };
}
