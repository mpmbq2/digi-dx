import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendQsoLog } from "../ui/qso-log.js";
import {
  findOccupiedAf,
  formatReport,
  messageForQso,
  parseFt8Message,
  QsoAutomation,
  renderOccupancyBar,
  secondsUntilNextSlot,
  suggestClearAf,
  type AutomationTx,
  type DecodeRecord
} from "../ui/qso.js";

describe("FT8 QSO parser", () => {
  it("parses CQ, reports, roger reports, and terminal messages", () => {
    expect(parseFt8Message("CQ JA2KVB PM95")).toEqual({ type: "cq", call: "JA2KVB", grid: "PM95" });
    expect(parseFt8Message("N1MPM JA2KVB -12")).toEqual({
      type: "directed",
      to: "N1MPM",
      from: "JA2KVB",
      payload: { type: "report", report: "-12" }
    });
    expect(parseFt8Message("N1MPM JA2KVB R+04")).toEqual({
      type: "directed",
      to: "N1MPM",
      from: "JA2KVB",
      payload: { type: "r-report", report: "+04" }
    });
    expect(parseFt8Message("N1MPM JA2KVB RR73")).toMatchObject({
      type: "directed",
      payload: { type: "rr73" }
    });
    expect(parseFt8Message("N1MPM JA2KVB 73")).toMatchObject({
      type: "directed",
      payload: { type: "73" }
    });
  });

  it("formats reports with FT8 sign and two digits", () => {
    expect(formatReport(-7)).toBe("-07");
    expect(formatReport(3)).toBe("+03");
    expect(formatReport(14)).toBe("+14");
  });
});

describe("QsoAutomation sequencing", () => {
  it("runs the reply-to-CQ exchange through RR73 and final 73", () => {
    const automation = new QsoAutomation(fixedNow);
    const qso = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33");

    expect(qso).not.toBeNull();
    expect(automation.nextTransmission(1000)?.intent).toEqual({
      af: 1000,
      slot: "odd",
      message: "JA2KVB N1MPM FN33"
    });

    automation.handleDecode(decode("N1MPM JA2KVB -12", 1_800_000_015, -18), "N1MPM", "FN33");
    expect(automation.nextTransmission(1000)?.intent).toEqual({
      af: 1000,
      slot: "even",
      message: "JA2KVB N1MPM R-18"
    });

    automation.handleDecode(decode("N1MPM JA2KVB R+04", 1_800_000_015, -15), "N1MPM", "FN33");
    expect(automation.nextTransmission(1000)?.intent.message).toBe("JA2KVB N1MPM RR73");

    automation.handleDecode(decode("N1MPM JA2KVB RR73", 1_800_000_015, -14), "N1MPM", "FN33");
    const finalTx = automation.nextTransmission(1000);
    expect(finalTx?.intent.message).toBe("JA2KVB N1MPM 73");
    const result = automation.confirmTransmission(finalTx, {
      ts: 1_800_000_030,
      af: 1000,
      message: "JA2KVB N1MPM 73"
    });
    expect(result.events).toMatchObject([{ type: "qso_completed", reason: "final 73 transmitted" }]);
    expect(qso?.status).toBe("complete");
  });

  it("creates a standard QSO when someone replies to our CQ and stops the CQ row", () => {
    const automation = new QsoAutomation(fixedNow);
    const cq = automation.createCq("N1MPM", "FN33", "even");

    expect(automation.nextTransmission(1100)?.intent.message).toBe("CQ N1MPM FN33");
    const events = automation.handleDecode(decode("N1MPM JA2KVB PM95", 1_800_000_015, -7), "N1MPM", "FN33");

    expect(events.map((event) => event.type)).toEqual(["qso_created", "cq_stopped"]);
    expect(cq.status).toBe("stopped");
    expect(automation.qsos[1]?.theirCall).toBe("JA2KVB");
    expect(automation.nextTransmission(1100)?.intent).toEqual({
      af: 1100,
      slot: "even",
      message: "JA2KVB N1MPM -07"
    });
  });

  it("locks a QSO to the expected station addressed to my call", () => {
    const automation = new QsoAutomation(fixedNow);
    const qso = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33");

    automation.handleDecode(decode("N1MPM W1AW -12", 1_800_000_015, -18), "N1MPM", "FN33");
    automation.handleDecode(decode("W1AW JA2KVB -12", 1_800_000_015, -18), "N1MPM", "FN33");

    expect(qso?.step).toBe("call-grid");
    expect(messageForQso(qso!)).toBe("JA2KVB N1MPM FN33");
  });

  it("completes immediately on a received plain 73", () => {
    const automation = new QsoAutomation(fixedNow);
    const qso = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33");

    const events = automation.handleDecode(decode("N1MPM JA2KVB 73", 1_800_000_015, -10), "N1MPM", "FN33");

    expect(events).toMatchObject([{ type: "qso_completed", reason: "received 73" }]);
    expect(qso?.status).toBe("complete");
    expect(automation.nextTransmission(1000)).toBeNull();
  });
});

describe("QsoAutomation scheduler state", () => {
  it("selects the top eligible QSO and supports reordering", () => {
    const automation = new QsoAutomation(fixedNow);
    const first = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33")!;
    const second = automation.createReplyToCq(decode("CQ W1AW FN31", 1_800_000_000, -16), "N1MPM", "FN33")!;

    expect(automation.nextTransmission(1000)?.qsoId).toBe(second.id);
    automation.move(first.id, -1);
    expect(automation.nextTransmission(1000)?.qsoId).toBe(first.id);
  });

  it("counts only confirmed automated tx attempts and times out after five", () => {
    const automation = new QsoAutomation(fixedNow);
    const qso = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33")!;
    const pending = automation.nextTransmission(1000)!;

    expect(automation.confirmTransmission(null, txFor(pending)).matched).toBe(false);
    for (let attempt = 0; attempt < 5; attempt++) {
      automation.confirmTransmission(pending, txFor(pending));
    }

    expect(qso.attempts["call-grid"]).toBe(5);
    expect(qso.status).toBe("timed_out");
    expect(automation.nextTransmission(1000)).toBeNull();
  });

  it("pauses all active automation on cancel and can reset attempts", () => {
    const automation = new QsoAutomation(fixedNow);
    const qso = automation.createReplyToCq(decode("CQ JA2KVB PM95", 1_800_000_000, -16), "N1MPM", "FN33")!;

    automation.pauseAll("cancelled");
    expect(qso.status).toBe("paused");
    expect(automation.nextTransmission(1000)).toBeNull();

    qso.attempts["call-grid"] = 4;
    automation.resetAttempts(qso.id);
    expect(qso.status).toBe("active");
    expect(qso.attempts["call-grid"]).toBe(0);
  });

  it("calculates pre-arm timing and occupied AF from the last two matching parity slots", () => {
    expect(secondsUntilNextSlot("odd", 1_800_000_001_000)).toBe(14);
    expect(
      findOccupiedAf(
        [
          decode("CQ OLD FN33", 1_799_999_940, -10, 1000),
          decode("CQ JA2KVB PM95", 1_800_000_000, -10, 1200),
          decode("CQ W1AW FN31", 1_800_000_030, -10, 1048)
        ],
        1000,
        "even"
      )?.decode.message
    ).toBe("CQ W1AW FN31");
  });
});

describe("slot survey frequency helpers", () => {
  it("suggests the centre of the widest clear gap in the band", () => {
    expect(suggestClearAf([], 300, 2700)).toBe(1500);
    // stations clustered low: the wide upper gap 600->2700 wins, centre 1650
    expect(suggestClearAf([400, 500, 600], 300, 2700)).toBe(1650);
    // ignores occupants outside the band: only 1000 remains, widest gap 1000->2700
    expect(suggestClearAf([100, 2900, 1000], 300, 2700)).toBe(1850);
  });

  it("renders an occupancy strip with markers", () => {
    const bar = renderOccupancyBar([300, 2700], 300, 2700, 10, 1500);
    expect(bar.length).toBe(10);
    expect(bar[0]).toBe("#");
    expect(bar[9]).toBe("#");
    expect(bar).toContain("^");
  });
});

describe("appendQsoLog", () => {
  it("creates the data directory and appends JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-qso-log-"));
    const path = join(dir, "data", "qso-log.jsonl");

    await appendQsoLog(
      {
        completedAt: "2026-07-03T00:00:00.000Z",
        startedAt: "2026-07-03T00:00:00.000Z",
        myCall: "N1MPM",
        myGrid: "FN33",
        theirCall: "JA2KVB",
        theirGrid: "PM95",
        sentReport: "-07",
        receivedReport: "-12",
        txMessages: [],
        rxMessages: [],
        reason: "test"
      },
      path
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ theirCall: "JA2KVB", reason: "test" });
  });
});

function fixedNow(): Date {
  return new Date("2026-07-03T00:00:00.000Z");
}

function decode(message: string, ts: number, snr: number, af = 1000): DecodeRecord {
  return {
    ts,
    snr,
    dt: 0,
    af,
    message
  };
}

function txFor(pending: AutomationTx) {
  return {
    ts: 1_800_000_030,
    af: pending.intent.af,
    message: pending.intent.message
  };
}
