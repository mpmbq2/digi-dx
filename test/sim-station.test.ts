import { describe, expect, it } from "vitest";
import {
  SimStation,
  defaultRoster,
  formatSimReport,
  isNonAssignableCallsign,
  makeRng,
  randomCallsign,
  type SimStationSpec
} from "../src/daemon/sim-station.js";

// CONFORMANCE SUITE.
//
// These tests pin the simulator's FT8 sequencing against the protocol itself --
// not against core/qso.ts, and not against whatever the client happens to do.
// They are the reason a failing verification run cannot be quietly fixed by
// loosening the simulator: doing that breaks these instead.
//
// Nothing in this file imports core/qso.ts. That is deliberate. If it ever does,
// the simulator and the client can agree on a shared bug, and the whole
// verification path becomes theatre.

const OP = "N1MPM";

function station(overrides: Partial<SimStationSpec> = {}): SimStation {
  return new SimStation({
    call: "QQ1ABC",
    grid: "FN42",
    af: 1200,
    snr: -8,
    slot: "even",
    behavior: "calls-operator",
    ...overrides
  });
}

describe("SimStation — a station that calls the operator", () => {
  it("opens by calling the operator directly, not with CQ", () => {
    // The client's automation ignores a CQ (answering one is a human decision),
    // so a roster of pure CQ-callers would never engage it. A directed call is
    // what makes a headless QSO possible.
    expect(station().transmit(OP)).toBe("N1MPM QQ1ABC FN42");
  });

  it("walks the full FT8 sequence to completion", () => {
    const s = station();

    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");

    s.hear("QQ1ABC N1MPM -08", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC R-08");

    s.hear("QQ1ABC N1MPM RR73", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC 73");

    expect(s.state).toBe("done");
    expect(s.transmit(OP)).toBeNull();
  });

  it("records the report the operator sent it", () => {
    const s = station();
    s.hear("QQ1ABC N1MPM -12", OP);
    expect(s.receivedReport).toBe("-12");
  });

  it("treats RRR like RR73", () => {
    const s = station();
    s.hear("QQ1ABC N1MPM -08", OP);
    s.hear("QQ1ABC N1MPM RRR", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC 73");
  });

  it("repeats its call while the operator stays silent", () => {
    const s = station();
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");
  });

  it("abandons a stalled QSO rather than calling forever", () => {
    const s = station({ stallAfterSlots: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(s.transmit(OP)).not.toBeNull();
    }
    expect(s.transmit(OP)).toBeNull();
    expect(s.state).toBe("abandoned");
  });

  it("ignores traffic addressed to somebody else", () => {
    const s = station();
    s.hear("QQ9ZZZ N1MPM -08", OP);
    // Still calling: that report was for another station.
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");
  });

  it("ignores traffic from somebody other than the operator", () => {
    const s = station();
    s.hear("QQ1ABC QQ7XYZ -08", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC FN42");
  });
});

describe("SimStation — a station calling CQ", () => {
  it("calls CQ, which the client's automation deliberately ignores", () => {
    const s = station({ behavior: "calls-cq" });
    expect(s.transmit(OP)).toBe("CQ QQ1ABC FN42");
  });

  it("answers an operator who replies to its CQ, then runs the QSO out", () => {
    // This is the human path: the operator clicks reply, and the station takes
    // the callee's side of the exchange.
    const s = station({ behavior: "calls-cq" });
    expect(s.transmit(OP)).toBe("CQ QQ1ABC FN42");

    s.hear("QQ1ABC N1MPM FN33", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC -08");

    s.hear("QQ1ABC N1MPM R-05", OP);
    expect(s.transmit(OP)).toBe("N1MPM QQ1ABC RR73");

    s.hear("QQ1ABC N1MPM 73", OP);
    expect(s.state).toBe("done");
    expect(s.transmit(OP)).toBeNull();
  });
});

describe("SimStation message grammar", () => {
  it("never emits a message out of FT8 sequence", () => {
    // Walk the whole exchange and assert every emission is a legal FT8 frame:
    // either CQ, or `TO FROM PAYLOAD` with a recognized payload.
    const s = station();
    const emitted: string[] = [];
    const heard = ["QQ1ABC N1MPM -08", "QQ1ABC N1MPM RR73"];

    for (let slot = 0; slot < 6; slot += 1) {
      const message = s.transmit(OP);
      if (message) {
        emitted.push(message);
      }
      const next = heard.shift();
      if (next) {
        s.hear(next, OP);
      }
    }

    const payload = /^(?:[A-R]{2}\d{2}|R?[+-]\d{2}|RR73|RRR|73)$/;
    for (const message of emitted) {
      const tokens = message.split(" ");
      expect(tokens).toHaveLength(3);
      expect(tokens[0]).toBe(OP);
      expect(tokens[1]).toBe("QQ1ABC");
      expect(tokens[2]).toMatch(payload);
    }
  });

  it("formats reports as a signed two-digit value, clamped to the codeable range", () => {
    expect(formatSimReport(-8)).toBe("-08");
    expect(formatSimReport(0)).toBe("+00");
    expect(formatSimReport(7)).toBe("+07");
    expect(formatSimReport(-99)).toBe("-30");
    expect(formatSimReport(99)).toBe("+20");
  });
});

describe("simulated callsigns", () => {
  it("cannot belong to a real licensee", () => {
    // A "plausible" callsign is very likely somebody's actual callsign. ITU
    // reserves the Q prefix for Q-codes and never allocates it to an amateur
    // station, so a QQ-prefixed call is credible on the band and safe in a
    // screenshot.
    const rng = makeRng(1234);
    for (let i = 0; i < 50; i += 1) {
      const call = randomCallsign(rng);
      expect(isNonAssignableCallsign(call)).toBe(true);
      // Still structurally a callsign: letters, at least one digit, 3-15 chars.
      expect(call).toMatch(/^[A-Z0-9]{3,15}$/);
      expect(call).toMatch(/\d/);
    }
  });

  it("rejects a real callsign as assignable", () => {
    expect(isNonAssignableCallsign("N1MPM")).toBe(false);
    expect(isNonAssignableCallsign("K1ABC")).toBe(false);
  });
});

describe("roster", () => {
  it("always contains a station that calls the operator", () => {
    // Without one, a headless run has nothing to answer and times out.
    const roster = defaultRoster("N1MPM", "FN33", 42);
    expect(roster.stations.some((spec) => spec.behavior === "calls-operator")).toBe(true);
  });

  it("is reproducible from the same seed", () => {
    expect(defaultRoster("N1MPM", "FN33", 7)).toEqual(defaultRoster("N1MPM", "FN33", 7));
  });

  it("differs across seeds", () => {
    expect(defaultRoster("N1MPM", "FN33", 7)).not.toEqual(defaultRoster("N1MPM", "FN33", 8));
  });

  it("draws every callsign from the non-assignable range", () => {
    for (const spec of defaultRoster("N1MPM", "FN33", 99).stations) {
      expect(isNonAssignableCallsign(spec.call)).toBe(true);
    }
  });
});
