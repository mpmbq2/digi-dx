import { describe, expect, it } from "vitest";
import { parseInternalUdpLine } from "../src/daemon/ft8-udp-parse.js";

describe("parseInternalUdpLine", () => {
  // Fixtures below are real lines from a live `ft8cat -a` ALL.TXT capture,
  // with the yymmdd_hhmmss timestamp converted to the unix epoch that `-u`
  // (used with `-A`) would have produced.
  it("parses real decode lines", () => {
    expect(parseInternalUdpLine("1783048560 144.174 Rx FT8     10 -0.6 2024 WM8Q DL0EO -17")).toEqual({
      type: "decode",
      ts: 1783048560,
      snr: 10,
      dt: -0.6,
      af: 2024,
      mode: "FT8",
      message: "WM8Q DL0EO -17"
    });
  });

  it("parses real tx echo lines", () => {
    expect(parseInternalUdpLine("1783005075 144.174 Tx FT8      0  0.0 1000 CQ N1MPM FN42")).toEqual({
      type: "tx",
      ts: 1783005075,
      af: 1000,
      mode: "FT8",
      message: "CQ N1MPM FN42"
    });
  });

  it("keeps trailing decoder-pass metadata as part of the message", () => {
    expect(parseInternalUdpLine("1783048560 144.174 Rx FT8    -22  0.3 1993 CQ PY7XC HI21                       ? a1")).toEqual({
      type: "decode",
      ts: 1783048560,
      snr: -22,
      dt: 0.3,
      af: 1993,
      mode: "FT8",
      message: "CQ PY7XC HI21 ? A1"
    });
  });

  it("drops malformed lines", () => {
    expect(parseInternalUdpLine("garbage")).toBeNull();
  });

  it("drops lines with too few fields", () => {
    expect(parseInternalUdpLine("1783048560 144.174 Rx FT8 10 -0.6")).toBeNull();
  });
});
