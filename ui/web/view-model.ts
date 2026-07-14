// Pure, framework-agnostic helpers that turn raw controller state (decodes, QSO
// records, TX state) into the browser view-model. Kept free of I/O and timers so
// they can be unit-tested in isolation (test/web-view-model.test.ts); the server
// (ui/web/server.ts) supplies the live state and the browser renders the result.

import {
  messageForQso,
  oppositeSlot,
  parseFt8Message,
  slotFromTimestamp,
  type AutomationTx,
  type DecodeRecord,
  type QsoRecord,
  type TxSlot
} from "../../core/qso.js";
import { FT8_SLOT_MS, type SlotClock } from "../../core/slot-clock.js";

const SLOT_SECONDS = FT8_SLOT_MS / 1000;
import type {
  ActiveQsoView,
  CompletedQsoView,
  CycleView,
  DecodeKind,
  DecodeView,
  NowView,
  RosterEntryView,
  TxState
} from "./protocol.js";

// Context shared by the annotation helpers. `activeCallColors` maps an active
// standard QSO's callsign to its stable colour; `workedCalls` is the set of
// already-logged callsigns (upper-case).
export interface AnnotateContext {
  myCall: string;
  activeCallColors: Map<string, string>;
  workedCalls: Set<string>;
}

export function senderOf(message: string): string | null {
  const parsed = parseFt8Message(message);
  if (!parsed) {
    return null;
  }
  return parsed.type === "cq" ? parsed.call : parsed.from;
}

export function gridFrom(message: string): string | null {
  const parsed = parseFt8Message(message);
  if (!parsed) {
    return null;
  }
  if (parsed.type === "cq") {
    return parsed.grid;
  }
  return parsed.payload.type === "grid" ? parsed.payload.grid : null;
}

function mentionsMyCall(message: string, myCall: string): boolean {
  if (!myCall) {
    return false;
  }
  return message.trim().toUpperCase().split(/\s+/).includes(myCall.toUpperCase());
}

// Classify how a heard station should be coloured. Order matters: a station
// answering us (reply) beats an in-progress QSO colour, which beats worked.
export function classifyKind(
  from: string | null,
  message: string,
  ctx: AnnotateContext
): { kind: DecodeKind; color?: string } {
  if (mentionsMyCall(message, ctx.myCall)) {
    return { kind: "reply" };
  }
  if (from) {
    const color = ctx.activeCallColors.get(from);
    if (color) {
      return { kind: "qso", color };
    }
    if (ctx.workedCalls.has(from)) {
      return { kind: "worked" };
    }
  }
  return { kind: "normal" };
}

export function annotateDecode(record: DecodeRecord, ctx: AnnotateContext): DecodeView {
  const from = senderOf(record.message);
  const { kind, color } = classifyKind(from, record.message, ctx);
  return {
    ts: record.ts,
    snr: record.snr,
    af: record.af,
    message: record.message,
    from,
    grid: gridFrom(record.message),
    // Slot parity and cycle start are pure functions of the decode's own
    // timestamp, and decode timestamps are already in the clock's base -- so
    // these stay correct at any scale, and the browser never has to compute them.
    slot: slotFromTimestamp(record.ts),
    cycleStart: Math.floor(record.ts / SLOT_SECONDS) * SLOT_SECONDS,
    kind,
    ...(color ? { color } : {})
  };
}

// AFs decoded in the most recent RX period of the given parity — "the last set
// of decodes" for that slot. Empty until a period of that parity is heard.
// Ported from the private helper in ui/tui.ts.
export function latestSlotAfs(decodes: DecodeRecord[], parity: TxSlot): number[] {
  let latestStart = -1;
  for (const decode of decodes) {
    if (slotFromTimestamp(decode.ts) !== parity) {
      continue;
    }
    const start = Math.floor(decode.ts / 15) * 15;
    if (start > latestStart) {
      latestStart = start;
    }
  }
  if (latestStart < 0) {
    return [];
  }
  return decodes.filter((decode) => Math.floor(decode.ts / 15) * 15 === latestStart).map((decode) => decode.af);
}

// Even/Odd rosters: the stations heard transmitting, grouped by the slot they
// were heard in, deduped to the most recent decode per callsign. Sorted most
// recent first; the browser re-sorts by Time/Dist/SNR. `cap` bounds each list.
export function buildRosters(
  decodes: DecodeRecord[],
  ctx: AnnotateContext,
  nowMs: number,
  cap = 40
): { even: RosterEntryView[]; odd: RosterEntryView[] } {
  const nowSec = Math.floor(nowMs / 1000);
  const latestByCall = new Map<string, { record: DecodeRecord; parity: TxSlot }>();

  for (const record of decodes) {
    const from = senderOf(record.message);
    if (!from) {
      continue;
    }
    const previous = latestByCall.get(from);
    if (!previous || record.ts > previous.record.ts) {
      latestByCall.set(from, { record, parity: slotFromTimestamp(record.ts) });
    }
  }

  const even: RosterEntryView[] = [];
  const odd: RosterEntryView[] = [];
  for (const [from, { record, parity }] of latestByCall) {
    const { kind, color } = classifyKind(from, record.message, ctx);
    const entry: RosterEntryView = {
      call: from,
      grid: gridFrom(record.message),
      snr: record.snr,
      ageSec: Math.max(0, nowSec - record.ts),
      af: record.af,
      kind,
      ...(color ? { color } : {})
    };
    (parity === "even" ? even : odd).push(entry);
  }

  const byRecency = (a: RosterEntryView, b: RosterEntryView): number => a.ageSec - b.ageSec;
  even.sort(byRecency);
  odd.sort(byRecency);
  return { even: even.slice(0, cap), odd: odd.slice(0, cap) };
}

// A QSO we replied to a CQ from, or that answered us, reads as a "caller"; one
// we initiated against a specific callsign reads as "hunted". Derived from
// whether the first thing we heard from them was directed at us.
function qsoKind(qso: QsoRecord): "hunted" | "caller" {
  const first = qso.rxMessages[0];
  if (!first) {
    return "hunted";
  }
  const parsed = parseFt8Message(first.message);
  if (parsed?.type === "cq") {
    return "caller";
  }
  if (parsed?.type === "directed" && parsed.to === qso.myCall) {
    return "caller";
  }
  return "hunted";
}

export function buildActiveQsoView(
  qsos: QsoRecord[],
  colorFor: (id: string) => string,
  txingQsoId: string | null,
  nowMs: number
): ActiveQsoView[] {
  const nowSec = Math.floor(nowMs / 1000);
  return qsos
    .filter((qso) => qso.kind !== "calling-cq" && qso.status !== "complete")
    .map((qso, index) => {
      const lastRx = qso.rxMessages[qso.rxMessages.length - 1] ?? null;
      return {
        id: qso.id,
        call: qso.theirCall,
        grid: qso.theirGrid,
        priority: index + 1,
        kind: qsoKind(qso),
        stepKey: qso.step,
        status: qso.status,
        attempts: qso.attempts[qso.step] ?? 0,
        slot: qso.nextSlot,
        heardAgoSec: lastRx ? Math.max(0, nowSec - lastRx.ts) : null,
        lastRx: lastRx?.message ?? null,
        nextTx: messageForQso(qso),
        txing: qso.id === txingQsoId,
        note: qso.note,
        color: colorFor(qso.id)
      };
    });
}

export function buildCompletedView(qsos: QsoRecord[]): CompletedQsoView[] {
  return qsos
    .filter((qso) => qso.status === "complete")
    .map((qso) => {
      const lastTx = qso.txMessages[qso.txMessages.length - 1] ?? null;
      return {
        id: qso.id,
        call: qso.theirCall,
        grid: qso.theirGrid,
        sentReport: qso.sentReport,
        receivedReport: qso.receivedReport,
        slot: lastTx?.slot ?? null,
        time: qso.updatedAt.slice(11, 16)
      };
    })
    .reverse();
}

// The Now/TX card core fields. The daemon's live tx state passes through; the
// message/af/slot come from the pending automation transmission. The browser
// folds in `txEnabled` to show the on-air / pending / halted presentation.
export function deriveTxCard(
  latestTxState: TxState,
  pending: AutomationTx | null
): Pick<NowView, "txState" | "message" | "af" | "slot"> {
  return {
    txState: latestTxState,
    message: pending?.intent.message ?? null,
    af: pending?.intent.af ?? null,
    slot: pending?.intent.slot ?? null
  };
}

// The browser holds no clock of its own, so the server hands it a parity plus the
// wall instant of the next boundary. Everything scale-shaped is resolved here,
// where core/slot-clock.ts is importable and the test suite can reach it.
export function buildCycleView(
  clock: SlotClock | null,
  wallNowMs: number,
  virtualNowMs: number
): CycleView {
  const parity = cycleParity(virtualNowMs);
  if (!clock) {
    return { parity, nextBoundaryWallMs: null, slotWallMs: null, slotSeconds: null };
  }
  // The next boundary is always the start of the opposite parity's slot.
  const virtualSeconds = clock.secondsUntilSlot(oppositeSlot(parity));
  return {
    parity,
    nextBoundaryWallMs: wallNowMs + clock.toWallMs(virtualSeconds * 1000),
    slotWallMs: clock.toWallMs(clock.spec.slotMs),
    slotSeconds: clock.spec.slotMs / 1000
  };
}

export function cycleParity(nowMs: number): TxSlot {
  return slotFromTimestamp(Math.floor(nowMs / 1000));
}
