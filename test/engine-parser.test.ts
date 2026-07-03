import { describe, expect, it } from "vitest";
import { parseInternalUdpLine } from "../src/daemon/engine.js";

describe("parseInternalUdpLine", () => {
  it("parses unix-timestamp decode lines", () => {
    expect(parseInternalUdpLine("1782994695 -4 0.3 1294 ~ JA2KVB K2L R-15")).toEqual({
      type: "decode",
      ts: 1782994695,
      snr: -4,
      dt: 0.3,
      af: 1294,
      mode: "FT8",
      message: "JA2KVB K2L R-15"
    });
  });

  it("parses tx echo lines", () => {
    expect(parseInternalUdpLine("E: 1782994715 2262 FT8 JA2KVB N1MPM R-15")).toEqual({
      type: "tx",
      ts: 1782994715,
      af: 2262,
      mode: "FT8",
      message: "JA2KVB N1MPM R-15"
    });
  });

  it("drops malformed lines", () => {
    expect(parseInternalUdpLine("garbage")).toBeNull();
  });
});
