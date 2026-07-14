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
      changedPaths: ["ui/web/server.ts", "src/daemon/sim-station.ts", "README.md"]
    });
    expect(result.ok).toBe(true);
    expect(result.banner).toBe(NOT_INDEPENDENT_BANNER);
    expect(result.touchedWatched).toEqual(["src/daemon/sim-station.ts"]);
  });

  it("banners when smoke scripts themselves change", () => {
    const touched = classifyWatchedChanges(["scripts/smoke.ts", "scripts/smoke-independence.ts"]);
    expect(touched).toEqual(["scripts/smoke-independence.ts", "scripts/smoke.ts"]);
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: touched
    });
    expect(result.banner).toBe(NOT_INDEPENDENT_BANNER);
  });

  it("produces no banner when watched paths are untouched", () => {
    const result = evaluateIndependence({
      mergeBase: "abc123",
      changedPaths: ["ui/web/server.ts", "docs/install.md"]
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
