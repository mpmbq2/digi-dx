import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bandForMHz, buildAdif, entryToAdif } from "../ui/adif.js";
import { appendQsoLog, readQsoLog } from "../ui/qso-log.js";
import type { QsoLogEntry } from "../ui/qso.js";

function entry(overrides: Partial<QsoLogEntry> = {}): QsoLogEntry {
  return {
    completedAt: "2026-07-07T14:46:00.000Z",
    startedAt: "2026-07-07T14:45:28.000Z",
    myCall: "N1MPM",
    myGrid: "FN34",
    theirCall: "K8BL",
    theirGrid: "EN91",
    sentReport: "-04",
    receivedReport: "+00",
    txMessages: [],
    rxMessages: [],
    dialFreqHz: 14_074_000,
    reason: "final 73 transmitted",
    ...overrides
  };
}

describe("bandForMHz", () => {
  it("maps common FT8 dial frequencies to bands", () => {
    expect(bandForMHz(14.074)).toBe("20m");
    expect(bandForMHz(7.074)).toBe("40m");
    expect(bandForMHz(3.573)).toBe("80m");
    expect(bandForMHz(28.074)).toBe("10m");
  });

  it("returns null outside the ham bands", () => {
    expect(bandForMHz(13.0)).toBeNull();
    expect(bandForMHz(0)).toBeNull();
  });
});

describe("entryToAdif", () => {
  it("encodes fields with byte lengths and derives BAND/FREQ", () => {
    const record = entryToAdif(entry());
    expect(record).toContain("<CALL:4>K8BL ");
    expect(record).toContain("<GRIDSQUARE:4>EN91 ");
    expect(record).toContain("<MODE:3>FT8 ");
    expect(record).toContain("<QSO_DATE:8>20260707 ");
    expect(record).toContain("<TIME_ON:6>144528 ");
    expect(record).toContain("<TIME_OFF:6>144600 ");
    expect(record).toContain("<RST_SENT:3>-04 ");
    expect(record).toContain("<RST_RCVD:3>+00 ");
    expect(record).toContain("<FREQ:9>14.074000 ");
    expect(record).toContain("<BAND:3>20m ");
    expect(record).toContain("<STATION_CALLSIGN:5>N1MPM ");
    expect(record.endsWith("<EOR>")).toBe(true);
  });

  it("omits FREQ/BAND when no dial frequency was set", () => {
    const record = entryToAdif(entry({ dialFreqHz: null }));
    expect(record).not.toContain("<FREQ");
    expect(record).not.toContain("<BAND");
  });

  it("omits optional fields that are missing", () => {
    const record = entryToAdif(entry({ theirGrid: null, sentReport: null, receivedReport: null }));
    expect(record).not.toContain("<GRIDSQUARE");
    expect(record).not.toContain("<RST_SENT");
    expect(record).not.toContain("<RST_RCVD");
  });
});

describe("buildAdif", () => {
  it("writes a header and one record per entry", () => {
    const adif = buildAdif([entry(), entry({ theirCall: "K2B" })]);
    expect(adif).toContain("<ADIF_VER:5>3.1.4 ");
    expect(adif).toContain("<PROGRAMID:7>digi-dx ");
    expect(adif).toContain("<EOH>");
    expect(adif.match(/<EOR>/g)).toHaveLength(2);
  });

  it("produces a valid file with no records", () => {
    const adif = buildAdif([]);
    expect(adif).toContain("<EOH>");
    expect(adif).not.toContain("<EOR>");
  });
});

describe("readQsoLog", () => {
  it("returns [] when the log file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-adif-"));
    expect(await readQsoLog(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("round-trips appended entries and skips corrupt lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-adif-"));
    const path = join(dir, "qso-log.jsonl");
    await appendQsoLog(entry({ theirCall: "K8BL" }), path);
    await appendQsoLog(entry({ theirCall: "K2B" }), path);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "{ not json\n", "utf8");
    const entries = await readQsoLog(path);
    expect(entries.map((item) => item.theirCall)).toEqual(["K8BL", "K2B"]);
  });
});
