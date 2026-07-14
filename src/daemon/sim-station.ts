// A simulated FT8 operator on the far side of the band.
//
// This is a SECOND, INDEPENDENT implementation of FT8 QSO sequencing. It shares
// no code with core/qso.ts on purpose: a simulator built on the client's own
// engine would agree with the client's bugs, and a passing test would prove only
// that both sides are wrong in the same way. The duplication is the point.
//
// It is also pinned by its own conformance tests (test/sim-station.test.ts),
// written against the FT8 protocol rather than against the client. An agent that
// tries to quiet a failing verification run by loosening a station's behavior
// breaks those tests instead.

export type SimSlot = "even" | "odd";

// ITU never allocates callsign prefixes beginning with Q to amateur stations --
// the Q series is reserved for Q-codes. So a QQ-prefixed callsign is
// structurally valid, parses like any other, and cannot belong to a real
// licensee. Demo screenshots and PR artifacts therefore never show a fabricated
// QSO against somebody's actual callsign.
const RESERVED_PREFIX = "QQ";

export function isNonAssignableCallsign(call: string): boolean {
  return call.toUpperCase().startsWith(RESERVED_PREFIX);
}

// Deterministic PRNG, so a roster plus a seed reproduces the same decisions.
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GRIDS = ["FN42", "EM73", "IO91", "JN58", "DM04", "CN87", "GF15", "PM95", "KP20", "FM19"];

export function randomCallsign(rng: () => number): string {
  const digit = Math.floor(rng() * 10);
  const suffix = Array.from({ length: 3 }, () => LETTERS[Math.floor(rng() * 26)]).join("");
  return `${RESERVED_PREFIX}${digit}${suffix}`;
}

export function randomGrid(rng: () => number): string {
  return GRIDS[Math.floor(rng() * GRIDS.length)]!;
}

// FT8 signal reports are two digits with a sign, clamped to the codeable range.
// Deliberately not core/qso.ts's formatReport -- see the note at the top.
export function formatSimReport(snr: number): string {
  const clamped = Math.max(-30, Math.min(20, Math.round(snr)));
  const sign = clamped < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(clamped)).padStart(2, "0")}`;
}

// Whether this station opens the QSO by calling the operator directly, or sits
// on the band calling CQ. The distinction matters: the client's automation
// ignores a CQ, because answering one is a human decision. A band of nothing but
// CQ-callers would leave a headless verification run watching decodes scroll by
// forever, so a roster must contain at least one caller.
export type SimBehavior = "calls-operator" | "calls-cq";

export interface SimStationSpec {
  call: string;
  grid: string;
  af: number;
  snr: number;
  slot: SimSlot;
  behavior: SimBehavior;
  // Slots of silence from the operator before the station gives up. Real
  // operators do abandon a stalled QSO, and the client must cope with it.
  stallAfterSlots?: number;
}

type Phase =
  | "calling" // repeating our opener (a directed call, or CQ)
  | "send-report" // heard their grid; owe them a report
  | "send-r-report" // heard their report; owe them R-report
  | "send-rr73" // heard their R-report; owe them RR73
  | "send-73" // heard their RR73; owe them a final 73
  | "done"
  | "abandoned";

const DEFAULT_STALL_SLOTS = 8;

export class SimStation {
  readonly call: string;
  readonly grid: string;
  readonly af: number;
  readonly snr: number;
  readonly slot: SimSlot;
  private phase: Phase;
  private readonly behavior: SimBehavior;
  private readonly stallAfterSlots: number;
  private silentSlots = 0;
  private theirReport: string | null = null;

  constructor(spec: SimStationSpec) {
    this.call = spec.call.toUpperCase();
    this.grid = spec.grid.toUpperCase();
    this.af = spec.af;
    this.snr = spec.snr;
    this.slot = spec.slot;
    this.behavior = spec.behavior;
    this.stallAfterSlots = spec.stallAfterSlots ?? DEFAULT_STALL_SLOTS;
    this.phase = "calling";
  }

  get state(): Phase {
    return this.phase;
  }

  get finished(): boolean {
    return this.phase === "done" || this.phase === "abandoned";
  }

  // What this station puts on the air in its slot, if anything.
  transmit(operatorCall: string): string | null {
    const op = operatorCall.toUpperCase();

    switch (this.phase) {
      case "calling":
        this.silentSlots += 1;
        if (this.silentSlots > this.stallAfterSlots) {
          this.phase = "abandoned";
          return null;
        }
        return this.behavior === "calls-operator"
          ? `${op} ${this.call} ${this.grid}`
          : `CQ ${this.call} ${this.grid}`;

      case "send-report":
        this.silentSlots += 1;
        if (this.silentSlots > this.stallAfterSlots) {
          this.phase = "abandoned";
          return null;
        }
        return `${op} ${this.call} ${formatSimReport(this.snr)}`;

      case "send-r-report":
        this.silentSlots += 1;
        if (this.silentSlots > this.stallAfterSlots) {
          this.phase = "abandoned";
          return null;
        }
        return `${op} ${this.call} R${formatSimReport(this.snr)}`;

      case "send-rr73":
        this.silentSlots += 1;
        if (this.silentSlots > this.stallAfterSlots) {
          this.phase = "abandoned";
          return null;
        }
        return `${op} ${this.call} RR73`;

      case "send-73":
        this.phase = "done";
        return `${op} ${this.call} 73`;

      case "done":
      case "abandoned":
        return null;
    }
  }

  // Something the operator transmitted. Only messages addressed to this station
  // move it along; everything else on the band is ignored, as on a real band.
  hear(message: string, operatorCall: string): void {
    const tokens = message.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (tokens.length < 3) {
      return;
    }
    const [to, from, payload] = tokens as [string, string, string];
    if (to !== this.call || from !== operatorCall.toUpperCase()) {
      return;
    }

    this.silentSlots = 0;

    if (payload === "73") {
      this.phase = "done";
      return;
    }
    if (payload === "RR73" || payload === "RRR") {
      // They are finished; we owe them a closing 73.
      this.phase = this.phase === "done" ? "done" : "send-73";
      return;
    }
    if (/^R[+-]\d{2}$/.test(payload)) {
      this.theirReport = payload.slice(1);
      this.phase = "send-rr73";
      return;
    }
    if (/^[+-]\d{2}$/.test(payload)) {
      this.theirReport = payload;
      this.phase = "send-r-report";
      return;
    }
    if (/^[A-R]{2}\d{2}$/.test(payload)) {
      // They answered our CQ with a grid; we owe them a report.
      this.phase = "send-report";
    }
  }

  get receivedReport(): string | null {
    return this.theirReport;
  }
}

export interface SimRoster {
  operatorCall: string;
  operatorGrid: string;
  stations: SimStationSpec[];
}

// The default band: one station calling the operator directly -- which is what
// engages the client's automation with no human in the loop -- plus CQ callers
// for texture, which an operator can answer by hand.
export function defaultRoster(operatorCall: string, operatorGrid: string, seed: number): SimRoster {
  const rng = makeRng(seed);
  const caller: SimStationSpec = {
    call: randomCallsign(rng),
    grid: randomGrid(rng),
    af: 800 + Math.floor(rng() * 400),
    snr: -14 + Math.floor(rng() * 20),
    slot: "even",
    behavior: "calls-operator"
  };

  const cqCallers: SimStationSpec[] = Array.from({ length: 3 }, () => ({
    call: randomCallsign(rng),
    grid: randomGrid(rng),
    af: 1300 + Math.floor(rng() * 1200),
    snr: -18 + Math.floor(rng() * 24),
    slot: rng() > 0.5 ? "even" : ("odd" as SimSlot),
    behavior: "calls-cq" as SimBehavior
  }));

  return {
    operatorCall: operatorCall.toUpperCase(),
    operatorGrid: operatorGrid.toUpperCase(),
    stations: [caller, ...cqCallers]
  };
}
