import type { DriverDecode, DriverTx } from "./engine-driver.js";
import type { DecodeEvent, TxEvent } from "./protocol.js";

// Real `ft8cat -A -u` lines follow the same layout as `-a` ALL.TXT-style
// output, only with an integer unix timestamp instead of a yymmdd_hhmmss
// field. Captured example (from a live session, non-`-u` timestamp):
//   260702_151115   144.174 Tx FT8      0  0.0 1000 CQ N1MPM FN42
//   260703_031600   144.174 Rx FT8     10 -0.6 2024 WM8Q DL0EO -17
// Fields are whitespace-padded for alignment, and some Rx lines carry extra
// trailing decoder-pass metadata (e.g. "? a1") that we keep as part of the
// message text; Phase 1 does not parse FT8 message grammar.
export function parseInternalUdpLine(line: string): DecodeEvent | TxEvent | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) {
    return null;
  }

  const [ts, freq, direction, mode, snr, dt, af, ...rest] = parts;
  if (!/^\d{10}$/.test(ts)) {
    return null;
  }
  if (!/^\d+(?:\.\d+)?$/.test(freq)) {
    return null;
  }
  if (direction !== "Rx" && direction !== "Tx") {
    return null;
  }
  if (mode !== "FT8" && mode !== "FT4") {
    return null;
  }
  if (!/^-?\d+$/.test(snr) || !/^[+-]?\d+(?:\.\d+)?$/.test(dt) || !/^\d+$/.test(af)) {
    return null;
  }

  const message = rest.join(" ").trim().toUpperCase();
  if (!message) {
    return null;
  }

  if (direction === "Rx") {
    return {
      type: "decode",
      ts: Number(ts),
      snr: Number(snr),
      dt: Number(dt),
      af: Number(af),
      mode,
      message
    };
  }

  return {
    type: "tx",
    ts: Number(ts),
    af: Number(af),
    mode,
    message
  };
}

export function parseInternalUdpLineToDriver(line: string): DriverDecode | DriverTx | null {
  const parsed = parseInternalUdpLine(line);
  if (!parsed) {
    return null;
  }
  if (parsed.type === "decode") {
    return {
      ts: parsed.ts,
      snr: parsed.snr,
      dt: parsed.dt,
      af: parsed.af,
      mode: parsed.mode,
      message: parsed.message
    };
  }
  return {
    ts: parsed.ts,
    af: parsed.af,
    mode: parsed.mode,
    message: parsed.message
  };
}
