export type TxSlot = "even" | "odd";

export interface DecodeRecord {
  ts: number;
  snr: number;
  dt: number;
  af: number;
  message: string;
}

export interface TxIntent {
  af: number;
  slot: TxSlot;
  message: string;
}

export interface TxConfirmation {
  ts: number;
  af: number;
  message: string;
}

export type DirectedPayload =
  | { type: "grid"; grid: string }
  | { type: "report"; report: string }
  | { type: "r-report"; report: string }
  | { type: "rrr" }
  | { type: "rr73" }
  | { type: "73" };

export type ParsedFt8Message =
  | { type: "cq"; call: string; grid: string | null }
  | { type: "directed"; to: string; from: string; payload: DirectedPayload };

export type QsoStep = "cq" | "call-grid" | "report" | "r-report" | "rr73" | "73" | "done";
export type QsoStatus = "active" | "paused" | "timed_out" | "stopped" | "complete";
export type QsoKind = "calling-cq" | "standard";

export interface QsoMessageRecord {
  ts: number;
  af?: number;
  slot?: TxSlot;
  snr?: number;
  message: string;
}

export interface QsoRecord {
  id: string;
  kind: QsoKind;
  status: QsoStatus;
  createdAt: string;
  updatedAt: string;
  myCall: string;
  myGrid: string;
  theirCall: string | null;
  theirGrid: string | null;
  step: QsoStep;
  nextSlot: TxSlot;
  attempts: Partial<Record<QsoStep, number>>;
  lastDecodeSnr: number | null;
  sentReport: string | null;
  receivedReport: string | null;
  rxMessages: QsoMessageRecord[];
  txMessages: QsoMessageRecord[];
  note: string | null;
}

export interface AutomationTx {
  qsoId: string;
  step: QsoStep;
  intent: TxIntent;
  attempt: number;
}

export type QsoAutomationEvent =
  | { type: "qso_created"; qso: QsoRecord }
  | { type: "qso_updated"; qso: QsoRecord; previousStep: QsoStep; reason: string }
  | { type: "qso_completed"; qso: QsoRecord; reason: string }
  | { type: "qso_timed_out"; qso: QsoRecord }
  | { type: "cq_stopped"; qso: QsoRecord };

export interface ConfirmTransmissionResult {
  matched: boolean;
  events: QsoAutomationEvent[];
}

export interface QsoLogEntry {
  completedAt: string;
  startedAt: string;
  myCall: string;
  myGrid: string;
  theirCall: string;
  theirGrid: string | null;
  sentReport: string | null;
  receivedReport: string | null;
  txMessages: QsoMessageRecord[];
  rxMessages: QsoMessageRecord[];
  reason: string;
}

export interface OccupiedAfMatch {
  decode: DecodeRecord;
  deltaHz: number;
}

const standardStepOrder: QsoStep[] = ["call-grid", "report", "r-report", "rr73", "73"];
const maxAttemptsPerStep = 5;

export class QsoAutomation {
  readonly qsos: QsoRecord[] = [];
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  createCq(myCall: string, myGrid: string, initialSlot: TxSlot, position: "top" | "bottom" = "top"): QsoRecord {
    const qso = this.makeQso({
      kind: "calling-cq",
      myCall,
      myGrid,
      theirCall: null,
      theirGrid: null,
      step: "cq",
      nextSlot: initialSlot
    });
    this.insertQso(qso, position);
    return qso;
  }

  createReplyToCq(
    decode: DecodeRecord,
    myCall: string,
    myGrid: string,
    position: "top" | "bottom" = "top"
  ): QsoRecord | null {
    const parsed = parseFt8Message(decode.message);
    if (!parsed || parsed.type !== "cq") {
      return null;
    }

    const qso = this.makeQso({
      kind: "standard",
      myCall,
      myGrid,
      theirCall: parsed.call,
      theirGrid: parsed.grid,
      step: "call-grid",
      nextSlot: oppositeSlot(slotFromTimestamp(decode.ts))
    });
    qso.rxMessages.push(decodeToMessageRecord(decode));
    this.insertQso(qso, position);
    return qso;
  }

  handleDecode(decode: DecodeRecord, myCall: string, myGrid: string): QsoAutomationEvent[] {
    const parsed = parseFt8Message(decode.message);
    if (!parsed || parsed.type !== "directed") {
      return [];
    }

    const normalizedMyCall = normalizeToken(myCall);
    if (!normalizedMyCall || parsed.to !== normalizedMyCall || parsed.from === normalizedMyCall) {
      return [];
    }

    const existing = this.qsos.find(
      (qso) =>
        qso.kind === "standard" &&
        qso.theirCall === parsed.from &&
        qso.myCall === normalizedMyCall &&
        qso.status !== "complete" &&
        qso.status !== "timed_out" &&
        qso.status !== "stopped"
    );
    if (existing) {
      return this.advanceFromDirected(existing, parsed.payload, decode);
    }

    const cq = this.qsos.find(
      (qso) => qso.kind === "calling-cq" && qso.myCall === normalizedMyCall && qso.status === "active"
    );
    if (!cq) {
      return [];
    }

    const qso = this.makeQso({
      kind: "standard",
      myCall: normalizedMyCall,
      myGrid,
      theirCall: parsed.from,
      theirGrid: payloadGrid(parsed.payload),
      step: stepForIncomingPayload(parsed.payload),
      nextSlot: oppositeSlot(slotFromTimestamp(decode.ts))
    });
    qso.lastDecodeSnr = decode.snr;
    qso.rxMessages.push(decodeToMessageRecord(decode));
    updateReportsFromPayload(qso, parsed.payload, decode.snr);
    this.insertQso(qso, "bottom");

    cq.status = "stopped";
    cq.note = `reply from ${parsed.from}`;
    cq.updatedAt = this.isoNow();
    return [
      { type: "qso_created", qso },
      { type: "cq_stopped", qso: cq }
    ];
  }

  nextTransmission(af: number): AutomationTx | null {
    const qso = this.qsos.find((candidate) => candidate.status === "active" && messageForQso(candidate));
    if (!qso) {
      return null;
    }

    const message = messageForQso(qso);
    if (!message) {
      return null;
    }

    return {
      qsoId: qso.id,
      step: qso.step,
      attempt: (qso.attempts[qso.step] ?? 0) + 1,
      intent: {
        af,
        slot: qso.nextSlot,
        message
      }
    };
  }

  confirmTransmission(pending: AutomationTx | null, tx: TxConfirmation): ConfirmTransmissionResult {
    if (!pending || normalizeMessage(tx.message) !== normalizeMessage(pending.intent.message)) {
      return { matched: false, events: [] };
    }

    const qso = this.qsos.find((candidate) => candidate.id === pending.qsoId);
    if (!qso) {
      return { matched: false, events: [] };
    }

    qso.txMessages.push({
      ts: tx.ts,
      af: tx.af,
      slot: pending.intent.slot,
      message: normalizeMessage(tx.message)
    });
    qso.attempts[pending.step] = (qso.attempts[pending.step] ?? 0) + 1;
    qso.updatedAt = this.isoNow();

    if (pending.step === "73") {
      qso.step = "done";
      qso.status = "complete";
      qso.note = null;
      return { matched: true, events: [{ type: "qso_completed", qso, reason: "final 73 transmitted" }] };
    }

    if ((qso.attempts[pending.step] ?? 0) >= maxAttemptsPerStep && qso.status === "active") {
      qso.status = "timed_out";
      qso.note = `timed out on ${pending.step}`;
      return { matched: true, events: [{ type: "qso_timed_out", qso }] };
    }

    return { matched: true, events: [] };
  }

  pauseAll(note: string): void {
    for (const qso of this.qsos) {
      if (qso.status === "active") {
        qso.status = "paused";
        qso.note = note;
        qso.updatedAt = this.isoNow();
      }
    }
  }

  resume(id: string): QsoRecord | null {
    const qso = this.findQso(id);
    if (!qso || qso.status === "complete") {
      return null;
    }
    qso.status = "active";
    qso.note = null;
    qso.updatedAt = this.isoNow();
    return qso;
  }

  complete(id: string, reason = "operator complete"): QsoAutomationEvent[] {
    const qso = this.findQso(id);
    if (!qso || qso.status === "complete") {
      return [];
    }
    qso.status = "complete";
    qso.step = "done";
    qso.note = null;
    qso.updatedAt = this.isoNow();
    return [{ type: "qso_completed", qso, reason }];
  }

  abandon(id: string): QsoRecord | null {
    const index = this.qsos.findIndex((qso) => qso.id === id);
    if (index === -1) {
      return null;
    }
    return this.qsos.splice(index, 1)[0] ?? null;
  }

  resetAttempts(id: string): QsoRecord | null {
    const qso = this.findQso(id);
    if (!qso) {
      return null;
    }
    qso.attempts[qso.step] = 0;
    if (qso.status === "timed_out" || qso.status === "paused" || qso.status === "stopped") {
      qso.status = "active";
    }
    qso.note = null;
    qso.updatedAt = this.isoNow();
    return qso;
  }

  previousStep(id: string): QsoRecord | null {
    return this.moveStep(id, -1);
  }

  nextStep(id: string): QsoRecord | null {
    return this.moveStep(id, 1);
  }

  move(id: string, delta: -1 | 1): QsoRecord | null {
    const index = this.qsos.findIndex((qso) => qso.id === id);
    if (index === -1) {
      return null;
    }
    const nextIndex = Math.max(0, Math.min(this.qsos.length - 1, index + delta));
    if (nextIndex === index) {
      return this.qsos[index] ?? null;
    }
    const [qso] = this.qsos.splice(index, 1);
    if (!qso) {
      return null;
    }
    this.qsos.splice(nextIndex, 0, qso);
    return qso;
  }

  toLogEntry(qso: QsoRecord, reason: string): QsoLogEntry | null {
    if (!qso.theirCall) {
      return null;
    }

    return {
      completedAt: qso.updatedAt,
      startedAt: qso.createdAt,
      myCall: qso.myCall,
      myGrid: qso.myGrid,
      theirCall: qso.theirCall,
      theirGrid: qso.theirGrid,
      sentReport: qso.sentReport,
      receivedReport: qso.receivedReport,
      txMessages: qso.txMessages,
      rxMessages: qso.rxMessages,
      reason
    };
  }

  private advanceFromDirected(
    qso: QsoRecord,
    payload: DirectedPayload,
    decode: DecodeRecord
  ): QsoAutomationEvent[] {
    const previousStep = qso.step;
    qso.nextSlot = oppositeSlot(slotFromTimestamp(decode.ts));
    qso.lastDecodeSnr = decode.snr;
    qso.rxMessages.push(decodeToMessageRecord(decode));
    updateReportsFromPayload(qso, payload, decode.snr);

    if (payload.type === "73") {
      qso.step = "done";
      qso.status = "complete";
      qso.note = null;
      qso.updatedAt = this.isoNow();
      return [{ type: "qso_completed", qso, reason: "received 73" }];
    }

    const nextStep = stepForIncomingPayload(payload);
    if (stepRank(nextStep) >= stepRank(qso.step)) {
      qso.step = nextStep;
    }

    qso.updatedAt = this.isoNow();
    return [{ type: "qso_updated", qso, previousStep, reason: payload.type }];
  }

  private moveStep(id: string, delta: -1 | 1): QsoRecord | null {
    const qso = this.findQso(id);
    if (!qso || qso.kind !== "standard") {
      return null;
    }
    const index = standardStepOrder.indexOf(qso.step);
    if (index === -1) {
      return null;
    }
    const nextStep = standardStepOrder[Math.max(0, Math.min(standardStepOrder.length - 1, index + delta))];
    if (!nextStep) {
      return qso;
    }
    qso.step = nextStep;
    if (qso.status !== "complete") {
      qso.status = "active";
    }
    qso.note = null;
    qso.updatedAt = this.isoNow();
    return qso;
  }

  private makeQso(input: {
    kind: QsoKind;
    myCall: string;
    myGrid: string;
    theirCall: string | null;
    theirGrid: string | null;
    step: QsoStep;
    nextSlot: TxSlot;
  }): QsoRecord {
    const now = this.isoNow();
    return {
      id: `qso-${this.nextId++}`,
      kind: input.kind,
      status: "active",
      createdAt: now,
      updatedAt: now,
      myCall: normalizeToken(input.myCall),
      myGrid: normalizeToken(input.myGrid),
      theirCall: input.theirCall ? normalizeToken(input.theirCall) : null,
      theirGrid: input.theirGrid ? normalizeToken(input.theirGrid) : null,
      step: input.step,
      nextSlot: input.nextSlot,
      attempts: {},
      lastDecodeSnr: null,
      sentReport: null,
      receivedReport: null,
      rxMessages: [],
      txMessages: [],
      note: null
    };
  }

  private insertQso(qso: QsoRecord, position: "top" | "bottom"): void {
    if (position === "top") {
      this.qsos.unshift(qso);
      return;
    }
    this.qsos.push(qso);
  }

  private findQso(id: string): QsoRecord | null {
    return this.qsos.find((qso) => qso.id === id) ?? null;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function parseFt8Message(message: string): ParsedFt8Message | null {
  const tokens = normalizeMessage(message).split(/\s+/).filter(Boolean);
  const metadataIndex = tokens.indexOf("?");
  const usefulTokens = metadataIndex === -1 ? tokens : tokens.slice(0, metadataIndex);

  if (usefulTokens[0] === "CQ") {
    const gridIndex = findLastIndex(usefulTokens, (token) => isGrid(token));
    if (gridIndex > 1 && isCallsign(usefulTokens[gridIndex - 1] ?? "")) {
      return {
        type: "cq",
        call: usefulTokens[gridIndex - 1]!,
        grid: usefulTokens[gridIndex]!
      };
    }
    const call = findLast(usefulTokens, (token) => isCallsign(token));
    return call ? { type: "cq", call, grid: null } : null;
  }

  if (usefulTokens.length < 3 || !isCallsign(usefulTokens[0] ?? "") || !isCallsign(usefulTokens[1] ?? "")) {
    return null;
  }

  const payload = parseDirectedPayload(usefulTokens[2]!);
  if (!payload) {
    return null;
  }

  return {
    type: "directed",
    to: usefulTokens[0]!,
    from: usefulTokens[1]!,
    payload
  };
}

export function messageForQso(qso: QsoRecord): string | null {
  switch (qso.step) {
    case "cq":
      return `CQ ${qso.myCall} ${qso.myGrid}`;
    case "call-grid":
      return qso.theirCall ? `${qso.theirCall} ${qso.myCall} ${qso.myGrid}` : null;
    case "report": {
      if (!qso.theirCall || qso.lastDecodeSnr === null) {
        return null;
      }
      const report = formatReport(qso.lastDecodeSnr);
      qso.sentReport = report;
      return `${qso.theirCall} ${qso.myCall} ${report}`;
    }
    case "r-report": {
      if (!qso.theirCall || qso.lastDecodeSnr === null) {
        return null;
      }
      const report = formatReport(qso.lastDecodeSnr);
      qso.sentReport = report;
      return `${qso.theirCall} ${qso.myCall} R${report}`;
    }
    case "rr73":
      return qso.theirCall ? `${qso.theirCall} ${qso.myCall} RR73` : null;
    case "73":
      return qso.theirCall ? `${qso.theirCall} ${qso.myCall} 73` : null;
    case "done":
      return null;
  }
}

export function slotFromTimestamp(ts: number): TxSlot {
  return Math.floor(ts / 15) % 2 === 0 ? "even" : "odd";
}

export function oppositeSlot(slot: TxSlot): TxSlot {
  return slot === "even" ? "odd" : "even";
}

export function secondsUntilNextSlot(slot: TxSlot, nowMs = Date.now()): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  let nextStart = (Math.floor(nowSeconds / 15) + 1) * 15;
  while (slotFromTimestamp(nextStart) !== slot) {
    nextStart += 15;
  }
  return nextStart - nowSeconds;
}

export function formatReport(snr: number): string {
  const rounded = Math.max(-50, Math.min(49, Math.round(snr)));
  const sign = rounded < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(rounded)).padStart(2, "0")}`;
}

export function findOccupiedAf(
  decodes: DecodeRecord[],
  af: number,
  txSlot: TxSlot,
  rangeHz = 50,
  matchingSlotCount = 2
): OccupiedAfMatch | null {
  const selectedSlotStarts = new Set<number>();
  const recentMatching: DecodeRecord[] = [];

  for (let index = decodes.length - 1; index >= 0; index--) {
    const decode = decodes[index]!;
    if (slotFromTimestamp(decode.ts) !== txSlot) {
      continue;
    }

    const slotStart = Math.floor(decode.ts / 15) * 15;
    if (!selectedSlotStarts.has(slotStart) && selectedSlotStarts.size >= matchingSlotCount) {
      continue;
    }

    selectedSlotStarts.add(slotStart);
    recentMatching.push(decode);
  }

  const occupied = recentMatching
    .map((decode) => ({ decode, deltaHz: Math.abs(decode.af - af) }))
    .filter((match) => match.deltaHz <= rangeHz)
    .sort((a, b) => a.deltaHz - b.deltaHz);

  return occupied[0] ?? null;
}

export function normalizeMessage(message: string): string {
  return message.trim().toUpperCase().replace(/\s+/g, " ");
}

function parseDirectedPayload(token: string): DirectedPayload | null {
  // Check terminal literals before isGrid: "RR73" also matches the Maidenhead
  // grid pattern ([A-R]{2}\d{2}), so it must be classified as rr73 first.
  if (token === "RRR") {
    return { type: "rrr" };
  }
  if (token === "RR73") {
    return { type: "rr73" };
  }
  if (token === "73") {
    return { type: "73" };
  }
  if (/^R[+-]\d{2}$/.test(token)) {
    return { type: "r-report", report: token.slice(1) };
  }
  if (/^[+-]\d{2}$/.test(token)) {
    return { type: "report", report: token };
  }
  if (isGrid(token)) {
    return { type: "grid", grid: token };
  }
  return null;
}

function isCallsign(token: string): boolean {
  return /^[A-Z0-9/]{3,15}$/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && !isGrid(token);
}

function isGrid(token: string): boolean {
  return /^[A-R]{2}\d{2}(?:[A-X]{2})?$/.test(token);
}

function normalizeToken(value: string): string {
  return value.trim().toUpperCase();
}

function decodeToMessageRecord(decode: DecodeRecord): QsoMessageRecord {
  return {
    ts: decode.ts,
    af: decode.af,
    snr: decode.snr,
    message: normalizeMessage(decode.message)
  };
}

function payloadGrid(payload: DirectedPayload): string | null {
  return payload.type === "grid" ? payload.grid : null;
}

function stepForIncomingPayload(payload: DirectedPayload): QsoStep {
  switch (payload.type) {
    case "grid":
      return "report";
    case "report":
      return "r-report";
    case "r-report":
      return "rr73";
    case "rrr":
    case "rr73":
      return "73";
    case "73":
      return "done";
  }
}

function updateReportsFromPayload(qso: QsoRecord, payload: DirectedPayload, decodeSnr: number): void {
  if (payload.type === "report" || payload.type === "r-report") {
    qso.receivedReport = payload.report;
  }
  if (payload.type === "grid") {
    qso.theirGrid = payload.grid;
  }
  if (payload.type === "grid" || payload.type === "report") {
    qso.sentReport = formatReport(decodeSnr);
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  const index = findLastIndex(items, predicate);
  return index === -1 ? undefined : items[index];
}

function stepRank(step: QsoStep): number {
  if (step === "cq") {
    return -1;
  }
  if (step === "done") {
    return standardStepOrder.length;
  }
  return standardStepOrder.indexOf(step);
}
