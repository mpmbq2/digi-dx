import { describe, expect, it } from "vitest";
import { QsoAutomation, type DecodeRecord } from "../ui/qso.js";
import {
  annotateDecode,
  buildActiveQsoView,
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
