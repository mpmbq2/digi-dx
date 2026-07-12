import blessed from "blessed";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { appendQsoLog, readQsoLog } from "./qso-log.js";
import { readTuiState, writeTuiState } from "./tui-state.js";
import { bandForMHz, buildAdif } from "./adif.js";
import {
  findOccupiedAf,
  messageForQso,
  oppositeSlot,
  parseFt8Message,
  QsoAutomation,
  renderOccupancyBar,
  secondsUntilNextSlot,
  slotFromTimestamp,
  suggestClearAf,
  type AutomationTx,
  type DecodeRecord,
  type QsoAutomationEvent,
  type QsoRecord,
  type TxSlot
} from "../core/qso.js";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8788";
const token = process.env.DIGI_DX_AUTH_TOKEN;

const decodes: DecodeRecord[] = [];

// Band Activity is a chronological list of rows: decodes, per-cycle separators,
// and our own TX lines. bandRows mirrors the list items 1:1 so a selected row
// maps back to its decode (separators/TX rows are not selectable for reply).
type BandRow = { kind: "decode"; decode: DecodeRecord } | { kind: "sep" } | { kind: "tx" };
const bandRows: BandRow[] = [];
let lastBandPeriod: number | null = null;

let myCall = "";
let myGrid = "";
let idCounter = 1;

// --- automation state -----------------------------------------------------

const automation = new QsoAutomation();
let selectedQsoId: string | null = null;
let pendingAutomationTx: AutomationTx | null = null;
let automationTimer: NodeJS.Timeout | null = null;
let manualOverridePending = false;
let latestTxState: "idle" | "pending" | "active" = "idle";
let statusBase = "connecting...";
const loggedQsoIds = new Set<string>();

// Control/session state, tracked structurally from status updates so the
// Start/Stop toggle and the auto-claim logic run off real state, not strings.
let controlHeld = false;
let controlMine = false;
let sessionActive = false;

// Operator-entered dial frequency (Hz). CAT control reports the wrong band on
// this setup, so this manual value is what gets logged and exported. Null until
// the operator sets it via the "freq…" command.
let dialFreqHz: number | null = null;

// Callsigns already in the QSO log — their decodes are greyed in Band Activity
// so we don't call a station we have already worked. Seeded from the log file
// at startup and extended as QSOs complete this session.
const workedCalls = new Set<string>();

// Slot survey: hold TX for one full receive cycle of our TX parity so the
// (otherwise deaf) TX slot can be observed, then suggest a clear frequency.
const SURVEY_LO_HZ = 300;
const SURVEY_HI_HZ = 2700;
const SURVEY_DECODE_LAG_SECONDS = 5;
let surveyActive = false;
let surveySlot: TxSlot | null = null;
let surveyStartSec = 0;
let surveyEndSec = 0;
let surveyTimer: NodeJS.Timeout | null = null;
const PLOT_WIDTH = 24;

// Last device id seen in a status update, used to pre-fill the save dialog.
let lastDeviceId: number | null = null;

const ws = new WebSocket(url);

function send(command: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    appendLog("not connected yet");
    return;
  }
  const id = String(idCounter++);
  ws.send(JSON.stringify({ id, ...command }));
}

// --- screen and widgets --------------------------------------------------

const screen = blessed.screen({
  smartCSR: true,
  mouse: true,
  title: "digi-dx"
});

const statusBar = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line" },
  label: " status ",
  content: "connecting..."
});

// Explicit height (not a bottom anchor) so blessed's list scroll math works;
// "48%-3" makes it end exactly at the QSO panel's top (row 3 + height = 48%).
const decodeList = blessed.list({
  top: 3,
  left: 0,
  width: "55%",
  height: "48%-3",
  border: { type: "line" },
  label: " band activity (dbl-click starts QSO, r=reply) ",
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: {
    selected: { bg: "blue", fg: "black" }
  }
});

// The QSO panel holds a CQ indicator (top line) and the active QSO list.
const qsoArea = blessed.box({ top: "48%", left: 0, width: "55%", height: "25%" });

const cqIndicator = blessed.box({
  parent: qsoArea,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  align: "center",
  content: ""
});

const qsoList = blessed.list({
  parent: qsoArea,
  top: 1,
  left: 0,
  width: "100%",
  bottom: 0,
  border: { type: "line" },
  label: " active qsos (r=reply c=cq u/d=reorder) ",
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { selected: { bg: "blue", fg: "black" } }
});

// Completed QSOs: bottom-left, under Active QSOs. Explicit height ("27%-3" ends
// at 100%-3, above the command bar) keeps list scrolling working.
const completedPanel = blessed.list({
  top: "73%",
  left: 0,
  width: "55%",
  height: "27%-3",
  border: { type: "line" },
  label: " completed qsos ",
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { selected: { bg: "blue", fg: "black" } }
});

const composePanel = blessed.box({
  top: 3,
  left: "55%",
  width: "45%",
  height: "70%",
  border: { type: "line" },
  label: " compose "
});

const afLabel = blessed.text({ parent: composePanel, top: 0, left: 1, content: "AF:" });
const afWarning = blessed.text({
  parent: composePanel,
  top: 0,
  left: 6,
  width: "80%",
  tags: true,
  content: ""
});
const afInput = blessed.textbox({
  parent: composePanel,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  border: { type: "line" },
  inputOnFocus: true,
  mouse: true,
  keys: true,
  style: { focus: { border: { fg: "cyan" } } },
  value: "1000"
});
afInput.on("click", () => {
  focusComposeInput(afInput);
  return false;
});
afInput.on("submit", () => {
  updateAfWarning();
  renderOccupancyPlots();
  scheduleAutomation();
  screen.render();
});

const surveyButton = blessed.button({
  parent: composePanel,
  top: 4,
  left: 1,
  width: "91%",
  height: 1,
  mouse: true,
  align: "center",
  content: "Survey TX slot (pause 1 cycle, find clear freq)",
  style: { fg: "black", bg: "cyan", focus: { bg: "blue" }, hover: { bg: "blue" } }
});
surveyButton.on("press", startSurvey);

// Live per-slot occupancy strips, refreshed each RX period. The slot you TX in
// stays stale until a Survey (or manual pause) lets the radio hear it; that
// slot's label is starred.
const evenPlot = blessed.text({ parent: composePanel, top: 5, left: 1, tags: true, content: "" });
const oddPlot = blessed.text({ parent: composePanel, top: 6, left: 1, tags: true, content: "" });

const slotButton = blessed.button({
  parent: composePanel,
  top: 7,
  left: 1,
  width: "90%",
  height: 3,
  border: { type: "line" },
  mouse: true,
  content: "slot: even (click to toggle)",
  align: "center"
});
let currentSlot: TxSlot = "even";
slotButton.on("press", () => {
  currentSlot = currentSlot === "even" ? "odd" : "even";
  slotButton.setContent(`slot: ${currentSlot} (click to toggle)`);
  updateAfWarning();
  renderOccupancyPlots();
  screen.render();
});

// No manual message composition: a target callsign drives Reply QSO. Fill it by
// double-clicking a decode (uses that message's sender) or by typing.
const targetLabel = blessed.text({
  parent: composePanel,
  top: 10,
  left: 1,
  content: "target callsign (dbl-click a decode):"
});
const targetInput = blessed.textbox({
  parent: composePanel,
  top: 11,
  left: 1,
  width: "90%",
  height: 3,
  border: { type: "line" },
  inputOnFocus: true,
  mouse: true,
  keys: true,
  style: { focus: { border: { fg: "cyan" } } }
});
targetInput.on("click", () => {
  focusComposeInput(targetInput);
  return false;
});

const cancelButton = blessed.button({
  parent: composePanel,
  top: 14,
  left: 1,
  width: "91%",
  height: 3,
  border: { type: "line" },
  mouse: true,
  align: "center",
  content: "CANCEL TX (pause automation)",
  style: { fg: "black", bg: "red" }
});
cancelButton.on("press", () => {
  send({ type: "cancel_transmit" });
  cancelSurvey("cancelled");
  pendingAutomationTx = null;
  manualOverridePending = false;
  clearAutomationTimer();
  automation.pauseAll("cancelled");
  renderQsoList();
});

// --- qso automation controls ---------------------------------------------

blessed.text({ parent: composePanel, top: 18, left: 1, content: "-- qso automation --" });

function opButton(top: number, left: string | number, content: string, handler: () => void): void {
  const button = blessed.button({
    parent: composePanel,
    top,
    left,
    width: "44%",
    height: 1,
    mouse: true,
    align: "center",
    content,
    style: { fg: "white", focus: { bg: "blue", fg: "black" }, hover: { bg: "blue", fg: "black" } }
  });
  button.on("press", handler);
}

opButton(19, 1, "Call CQ", callCq);
opButton(19, "48%", "Reply QSO", replyToTarget);
opButton(20, 1, "Resume", () => actOnSelected((qso) => automation.resume(qso.id)));
opButton(20, "48%", "Complete", () => {
  const qso = selectedQso();
  if (qso) {
    handleQsoEvents(automation.complete(qso.id));
    scheduleAutomation();
  }
});
opButton(21, 1, "Abandon", () => {
  const qso = selectedQso();
  if (qso) {
    automation.abandon(qso.id);
    selectedQsoId = null;
    scheduleAutomation();
  }
});
opButton(21, "48%", "Retry", () => actOnSelected((qso) => automation.resetAttempts(qso.id)));
opButton(22, 1, "Prev step", () => actOnSelected((qso) => automation.previousStep(qso.id)));
opButton(22, "48%", "Next step", () => actOnSelected((qso) => automation.nextStep(qso.id)));
opButton(23, 1, "Up", () => moveSelected(-1));
opButton(23, "48%", "Down", () => moveSelected(1));

const logBox = blessed.log({
  top: "73%",
  left: "55%",
  width: "45%",
  height: "27%-3",
  border: { type: "line" },
  label: " log ",
  scrollable: true,
  alwaysScroll: true
});

const commandBar = blessed.box({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: { type: "line" },
  label: " commands "
});

// One button per daemon command. The Session button toggles start/stop and
// auto-claims control; Release hands control back. Commands that need arguments
// (save) open a dialog pre-filled from current status; the rest send at once.
const commandButtons: Array<{ id?: string; label: string; run: () => void }> = [
  { id: "session", label: "▶ start", run: toggleSession },
  { label: "release", run: releaseControl },
  { label: "status", run: () => send({ type: "get_status" }) },
  { label: "config", run: () => send({ type: "get_config" }) },
  { label: "devices", run: () => send({ type: "list_audio_devices" }) },
  { label: "freq…", run: openFreqDialog },
  { label: "export…", run: openExportDialog },
  { label: "save…", run: openSaveDialog }
];
let sessionButton: ReturnType<typeof blessed.button> | null = null;
commandButtons.forEach((command, index) => {
  const button = blessed.button({
    parent: commandBar,
    top: 0,
    left: `${(index * 100) / commandButtons.length}%`,
    width: `${100 / commandButtons.length}%`,
    height: 1,
    mouse: true,
    align: "center",
    content: command.label,
    style: { fg: "white", focus: { bg: "blue", fg: "black" }, hover: { bg: "blue", fg: "black" } }
  });
  button.on("press", command.run);
  if (command.id === "session") {
    sessionButton = button;
  }
});
renderSessionButton();

// --- control workflow -----------------------------------------------------

// Ensure we hold control before a state-changing command. Auto-claims when
// control is free; refuses (with a friendly message) when another client holds
// it. The daemon processes the claim before the command sent right after it, so
// controlMine need not be updated yet for the follow-up command to succeed.
function ensureControl(): boolean {
  if (controlMine) {
    return true;
  }
  if (controlHeld) {
    appendLog("You do not have control (another client holds it)");
    return false;
  }
  send({ type: "claim_control", ...(token ? { token } : {}) });
  return true;
}

function toggleSession(): void {
  if (!ensureControl()) {
    return;
  }
  send({ type: sessionActive ? "stop_session" : "start_session" });
}

function releaseControl(): void {
  if (!controlMine) {
    appendLog(controlHeld ? "You do not have control (another client holds it)" : "control is not held");
    return;
  }
  send({ type: "release_control" });
}

// Label/colour the Session toggle from the live session state: green ▶ start
// when idle, red ■ stop while a session is running.
function renderSessionButton(): void {
  if (!sessionButton) {
    return;
  }
  sessionButton.setContent(sessionActive ? "■ stop" : "▶ start");
  sessionButton.style.bg = sessionActive ? "red" : "green";
  sessionButton.style.fg = "black";
  screen.render();
}

screen.append(statusBar);
screen.append(decodeList);
screen.append(completedPanel);
screen.append(qsoArea);
screen.append(composePanel);
screen.append(logBox);
screen.append(commandBar);

screen.key(["C-c"], () => process.exit(0));
screen.key(["tab"], () => screen.focusNext());
screen.key(["S-tab"], () => screen.focusPrevious());

let lastBandClickIndex = -1;
let lastBandClickTime = 0;
decodeList.on("select", (_item, index) => {
  const row = bandRows[index];
  if (!row || row.kind !== "decode") {
    return;
  }
  const record = row.decode;
  const now = Date.now();
  const doubleClick = index === lastBandClickIndex && now - lastBandClickTime < 500;
  lastBandClickIndex = index;
  lastBandClickTime = now;

  // Double click: start a reply QSO for this message's sender. Do not touch the
  // operator's AF field; a double click arrives as two list selections.
  if (doubleClick) {
    replyToDecode(record);
  }
  screen.render();
});

// 'r' replies to the selected decode's sender, or falls back to the target box.
decodeList.key(["r"], () => {
  const index = (decodeList as unknown as { selected: number }).selected;
  const row = bandRows[index];
  if (row && row.kind === "decode") {
    replyToDecode(row.decode);
    return;
  }
  replyToTarget();
});
decodeList.key(["c"], callCq);

// Replace blessed's default list wheel (which moves the selection and snaps the
// view back to it) with a plain viewport scroll, so wheeling starts from where
// you are looking — the bottom — rather than the stale selection.
const bandScroll = decodeList as unknown as { scroll(offset: number): void };
decodeList.removeAllListeners("element wheeldown");
decodeList.removeAllListeners("element wheelup");
decodeList.on("element wheeldown", () => {
  bandScroll.scroll(3);
  screen.render();
});
decodeList.on("element wheelup", () => {
  bandScroll.scroll(-3);
  screen.render();
});

function trackQsoSelection(): void {
  const index = (qsoList as unknown as { selected: number }).selected;
  const qso = renderedActive[index];
  if (qso) {
    selectedQsoId = qso.id;
  }
}
qsoList.on("select item", trackQsoSelection);
qsoList.on("select", trackQsoSelection);
qsoList.key(["c"], callCq);
qsoList.key(["u", "S-up"], () => moveSelected(-1));
qsoList.key(["d", "S-down"], () => moveSelected(1));

function senderOf(message: string): string | null {
  const parsed = parseFt8Message(message);
  if (!parsed) {
    return null;
  }
  return parsed.type === "cq" ? parsed.call : parsed.from;
}

function gridFrom(message: string): string | null {
  const parsed = parseFt8Message(message);
  if (!parsed) {
    return null;
  }
  if (parsed.type === "cq") {
    return parsed.grid;
  }
  return parsed.payload.type === "grid" ? parsed.payload.grid : null;
}

function replyToDecode(record: DecodeRecord): void {
  const sender = senderOf(record.message);
  if (!sender) {
    appendLog("selected decode has no sender callsign");
    return;
  }
  replyToCall(sender, oppositeSlot(slotFromTimestamp(record.ts)), gridFrom(record.message));
}

function findLastDecodeFrom(call: string): DecodeRecord | null {
  for (let index = decodes.length - 1; index >= 0; index--) {
    if (senderOf(decodes[index]!.message) === call) {
      return decodes[index]!;
    }
  }
  return null;
}

// Each active QSO gets a stable colour, used to tint its decodes in Band
// Activity and mark its row. Yellow is reserved for "replying to me".
const QSO_PALETTE = ["cyan", "magenta", "green", "blue", "red", "white"];
const qsoColors = new Map<string, string>();
let nextQsoColor = 0;
function colorForQso(qso: QsoRecord): string {
  let color = qsoColors.get(qso.id);
  if (!color) {
    color = QSO_PALETTE[nextQsoColor % QSO_PALETTE.length]!;
    nextQsoColor++;
    qsoColors.set(qso.id, color);
  }
  return color;
}

function mentionsMyCall(message: string): boolean {
  if (!myCall) {
    return false;
  }
  return message.split(/\s+/).includes(myCall);
}

function appendLog(line: string): void {
  logBox.log(line);
  screen.render();
}

// --- band activity rows ---------------------------------------------------

function pushBandSeparator(periodStart: number, youTx: boolean): void {
  if (lastBandPeriod === periodStart) {
    return;
  }
  const time = new Date(periodStart * 1000).toISOString().slice(11, 19);
  const parity = slotFromTimestamp(periodStart);
  bandRows.push({ kind: "sep" });
  decodeList.addItem(`{grey-fg}──── ${time}  ${parity}${youTx ? " · YOU TX" : ""} ────{/grey-fg}`);
  lastBandPeriod = periodStart;
}

function decodeMarkup(message: string, line: string): string {
  // Someone replying to me stays yellow, regardless of any QSO colour.
  if (mentionsMyCall(message)) {
    return `{black-fg}{yellow-bg}${line}{/yellow-bg}{/black-fg}`;
  }
  const sender = senderOf(message);
  if (sender) {
    const qso = automation.qsos.find(
      (candidate) => candidate.kind === "standard" && candidate.theirCall === sender && candidate.status !== "complete"
    );
    if (qso) {
      const color = colorForQso(qso);
      return `{black-fg}{${color}-bg}${line}{/${color}-bg}{/black-fg}`;
    }
    // Already worked (in the log): grey it out so we don't call them again.
    if (workedCalls.has(sender)) {
      return `{grey-fg}${line}{/grey-fg}`;
    }
  }
  return line;
}

function appendBandDecode(record: DecodeRecord): void {
  pushBandSeparator(Math.floor(record.ts / 15) * 15, false);
  bandRows.push({ kind: "decode", decode: record });
  const time = new Date(record.ts * 1000).toISOString().slice(11, 19);
  const line = `${time} ${String(record.snr).padStart(4)} ${String(record.af).padStart(5)}  ${record.message}`;
  decodeList.addItem(decodeMarkup(record.message, line));
  decodeList.scrollTo(bandRows.length);
}

// Our TX slot is deaf, so a cycle we transmit in has no decodes; show the TX
// message there instead.
function appendBandTx(ts: number, af: number, message: string): void {
  pushBandSeparator(Math.floor(ts / 15) * 15, true);
  bandRows.push({ kind: "tx" });
  decodeList.addItem(`{cyan-fg}» TX ${String(af).padStart(5)}  ${message}{/cyan-fg}`);
  decodeList.scrollTo(bandRows.length);
}

// --- cycle clock ----------------------------------------------------------
// Shows the current even/odd 15s period, the countdown to the next boundary,
// and whether we are transmitting. Ticks on a timer independent of daemon
// messages so the countdown stays live.

function clockSegment(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const parity = slotFromTimestamp(nowSec);
  const remain = 15 - (nowSec % 15);
  let tx: string;
  if (surveyActive) {
    const left = Math.max(0, surveyEndSec - nowSec);
    tx = `{cyan-fg}{bold}SURVEY ${surveySlot} t-${left}s{/bold}{/cyan-fg}`;
  } else if (latestTxState === "active") {
    tx = "{red-fg}{bold}TX{/bold}{/red-fg}";
  } else if (latestTxState === "pending") {
    tx = "{yellow-fg}TX-arm{/yellow-fg}";
  } else {
    tx = "{green-fg}RX{/green-fg}";
  }
  return `cycle={bold}${parity}{/bold} t-${String(remain).padStart(2)}s ${tx}`;
}

function renderStatusBar(): void {
  const qrg = dialFreqHz
    ? `{green-fg}${(dialFreqHz / 1e6).toFixed(3)}MHz{/green-fg}`
    : "{yellow-fg}unset{/yellow-fg}";
  statusBar.setContent(`${statusBase}  ||  ${clockSegment()}  ||  QRG=${qrg}`);
  screen.render();
}

function setDialFreqHz(value: number | null): void {
  dialFreqHz = value;
  renderStatusBar();
  void persistTuiState();
}

async function persistTuiState(): Promise<void> {
  try {
    await writeTuiState({ dialFreqHz });
  } catch (error) {
    appendLog(`[state error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- qso automation helpers ----------------------------------------------

function ensureAutomationIdentity(): boolean {
  if (!myCall || !myGrid) {
    appendLog("automation requires configured callsign and grid");
    return false;
  }
  return true;
}

function callCq(): void {
  if (!ensureAutomationIdentity()) {
    return;
  }
  automation.createCq(myCall, myGrid, currentSlot, "top");
  appendLog("[qso] calling CQ");
  renderQsoList();
  scheduleAutomation();
}

function replyToTarget(): void {
  if (!ensureAutomationIdentity()) {
    return;
  }
  const call = targetInput.getValue().trim().toUpperCase();
  if (!call) {
    appendLog("enter a target callsign (or double-click a decode)");
    return;
  }
  // Best-guess reply slot and their grid from the most recent decode of them.
  const last = findLastDecodeFrom(call);
  replyToCall(call, last ? oppositeSlot(slotFromTimestamp(last.ts)) : currentSlot, last ? gridFrom(last.message) : null);
}

function replyToCall(call: string, nextSlot: TxSlot, theirGrid: string | null): void {
  if (!ensureAutomationIdentity()) {
    return;
  }
  const normalizedCall = call.trim().toUpperCase();
  if (!/^[A-Z0-9/]{2,}$/.test(normalizedCall)) {
    appendLog(`'${normalizedCall}' is not a valid callsign`);
    return;
  }
  const existing = automation.qsos.find(
    (qso) => qso.kind === "standard" && qso.theirCall === normalizedCall && qso.status !== "complete"
  );
  if (existing) {
    appendLog(`QSO already exists for ${normalizedCall}`);
    selectQso(existing.id);
    return;
  }
  const qso = automation.createReplyToCall(normalizedCall, myCall, myGrid, nextSlot, theirGrid, "top");
  colorForQso(qso);
  appendLog(`[qso] reply to ${qso.theirCall}`);
  targetInput.clearValue();
  selectQso(qso.id);
  scheduleAutomation();
}

function selectedQso(): QsoRecord | null {
  if (!selectedQsoId) {
    return null;
  }
  return automation.qsos.find((qso) => qso.id === selectedQsoId) ?? null;
}

function selectQso(id: string | null): void {
  selectedQsoId = id;
  renderQsoList();
}

function actOnSelected(action: (qso: QsoRecord) => unknown): void {
  const qso = selectedQso();
  if (!qso) {
    return;
  }
  action(qso);
  scheduleAutomation();
}

function moveSelected(delta: -1 | 1): void {
  const qso = selectedQso();
  if (!qso) {
    return;
  }
  automation.move(qso.id, delta);
  scheduleAutomation();
}

function formatQsoRow(qso: QsoRecord, priority: number): string {
  const who = qso.theirCall ?? "CQ";
  const attempts = qso.attempts[qso.step] ?? 0;
  const preview = messageForQso(qso) ?? "-";
  const lastRx = qso.rxMessages[qso.rxMessages.length - 1]?.message ?? "-";
  const note = qso.note ? ` (${qso.note})` : "";
  const color = colorForQso(qso);
  const dot = `{${color}-fg}●{/${color}-fg}`;
  const base = `${priority} ${qso.status} ${who} ${qso.step} att=${attempts} rx>${lastRx} tx>${preview}${note}`;
  switch (qso.status) {
    case "timed_out":
      return `${dot} {red-fg}${base}{/red-fg}`;
    case "paused":
    case "stopped":
      return `${dot} {yellow-fg}${base}{/yellow-fg}`;
    default:
      return `${dot} ${base}`;
  }
}

function formatCompletedRow(qso: QsoRecord): string {
  const grid = qso.theirGrid ? ` ${qso.theirGrid}` : "";
  const reports = `${qso.sentReport ?? "?"}/${qso.receivedReport ?? "?"}`;
  return `{green-fg}✓ ${qso.theirCall ?? "?"}${grid} ${reports}{/green-fg}`;
}

function renderCqIndicator(): void {
  cqIndicator.setContent(
    automation.isCallingCq()
      ? "{green-bg}{black-fg} ● CALLING CQ {/black-fg}{/green-bg}"
      : "{grey-fg}○ CQ idle — press Call CQ to start{/grey-fg}"
  );
}

// Active QSOs exclude the hidden CQ row (shown via the indicator) and completed
// QSOs (shown in their own list). renderedActive maps list rows to records.
let renderedActive: QsoRecord[] = [];

function renderQsoList(): void {
  renderCqIndicator();

  renderedActive = automation.qsos.filter((qso) => qso.kind !== "calling-cq" && qso.status !== "complete");
  qsoList.setItems(renderedActive.map((qso, index) => formatQsoRow(qso, index + 1)));
  if (selectedQsoId) {
    const index = renderedActive.findIndex((qso) => qso.id === selectedQsoId);
    if (index >= 0) {
      qsoList.select(index);
    } else {
      selectedQsoId = null;
    }
  }

  renderCompleted();

  screen.render();
}

function renderCompleted(): void {
  completedPanel.setItems(automation.qsos.filter((qso) => qso.status === "complete").map(formatCompletedRow));
}

function handleQsoEvents(events: QsoAutomationEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "qso_created":
        colorForQso(event.qso);
        appendLog(`[qso] created ${event.qso.theirCall ?? "CQ"}`);
        break;
      case "qso_updated":
        appendLog(`[qso] ${event.qso.theirCall} ${event.previousStep} -> ${event.qso.step}`);
        break;
      case "qso_completed":
        appendLog(`[qso] complete ${event.qso.theirCall ?? "CQ"} (${event.reason})`);
        void logCompletedQso(event.qso, event.reason);
        break;
      case "qso_timed_out":
        appendLog(`[qso] timed out ${event.qso.theirCall ?? "CQ"} step=${event.qso.step}`);
        break;
      case "cq_stopped":
        appendLog("[qso] CQ stopped after reply");
        break;
    }
  }
  renderQsoList();
}

async function logCompletedQso(qso: QsoRecord, reason: string): Promise<void> {
  if (loggedQsoIds.has(qso.id)) {
    return;
  }
  const entry = automation.toLogEntry(qso, reason, dialFreqHz);
  if (!entry) {
    return;
  }
  loggedQsoIds.add(qso.id);
  try {
    await appendQsoLog(entry);
    workedCalls.add(entry.theirCall);
    appendLog(`[qso-log] wrote ${entry.theirCall}${dialFreqHz ? ` @${(dialFreqHz / 1e6).toFixed(3)}MHz` : " (no freq set)"}`);
  } catch (error) {
    loggedQsoIds.delete(qso.id);
    appendLog(`[qso-log error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- occupied AF warning --------------------------------------------------

function updateAfWarning(): void {
  const af = Number(afInput.getValue());
  if (!Number.isInteger(af)) {
    afWarning.setContent("");
    return;
  }
  const match = findOccupiedAf(decodes, af, currentSlot, 50, 2);
  afWarning.setContent(
    match ? `{yellow-fg}occupied +/-50Hz: ${match.decode.af} ${match.decode.message}{/yellow-fg}` : ""
  );
}

// The slot we transmit in: the active CQ row's slot, else the manual slot.
function currentTxSlot(): TxSlot {
  const cq = automation.qsos.find((qso) => qso.kind === "calling-cq" && qso.status === "active");
  return cq ? cq.nextSlot : currentSlot;
}

// AFs decoded in the most recent RX period of the given parity ("the last set
// of decodes" for that slot). Empty until a period of that parity is heard.
function latestSlotAfs(parity: TxSlot): number[] {
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

function renderOccupancyPlots(): void {
  const afValue = Number(afInput.getValue());
  const mark = Number.isInteger(afValue) ? afValue : undefined;
  const txSlot = currentTxSlot();
  const even = renderOccupancyBar(latestSlotAfs("even"), SURVEY_LO_HZ, SURVEY_HI_HZ, PLOT_WIDTH, mark);
  const odd = renderOccupancyBar(latestSlotAfs("odd"), SURVEY_LO_HZ, SURVEY_HI_HZ, PLOT_WIDTH, mark);
  evenPlot.setContent(`${txSlot === "even" ? "{bold}E*{/bold}" : "E "}|${even}|`);
  oddPlot.setContent(`${txSlot === "odd" ? "{bold}O*{/bold}" : "O "}|${odd}|`);
}

// --- scheduler ------------------------------------------------------------

function currentAfOrNull(): number | null {
  const af = Number(afInput.getValue());
  if (!Number.isInteger(af) || af < 200 || af > 3000) {
    return null;
  }
  return af;
}

function clearAutomationTimer(): void {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
}

// The daemon rests in "pending" after a transmission (its desiredTx lingers
// until cancel/clear), so we can never rely on seeing "idle" to resume. Re-arm
// automation on the falling edge of "active" (a transmission just finished), or
// on a genuine "idle" (e.g. after cancel).
function updateTxState(next: "idle" | "pending" | "active"): void {
  const wasActive = latestTxState === "active";
  latestTxState = next;
  if (manualOverridePending || surveyActive || next === "active") {
    return;
  }
  if (wasActive || next === "idle") {
    scheduleAutomation();
  }
}

function scheduleAutomation(): void {
  clearAutomationTimer();
  renderQsoList();
  updateAfWarning();

  if (surveyActive || manualOverridePending || latestTxState === "active") {
    return;
  }

  const af = currentAfOrNull();
  if (af === null) {
    return;
  }

  const tx = automation.nextTransmission(af);
  if (!tx) {
    return;
  }

  const seconds = secondsUntilNextSlot(tx.intent.slot);
  const delayMs = Math.max(0, (seconds - 2) * 1000);
  automationTimer = setTimeout(() => sendAutomatedTx(tx), delayMs);
}

function sendAutomatedTx(tx: AutomationTx): void {
  automationTimer = null;
  if (surveyActive || manualOverridePending || latestTxState === "active") {
    return;
  }
  const af = currentAfOrNull();
  if (af === null) {
    appendLog("automation paused: invalid AF");
    return;
  }

  const refreshed: AutomationTx = {
    ...tx,
    intent: { ...tx.intent, af }
  };

  pendingAutomationTx = refreshed;
  send({ type: "transmit", ...refreshed.intent });
  renderQsoList();
}

// --- slot survey ----------------------------------------------------------

function startSurvey(): void {
  if (surveyActive) {
    appendLog("[survey] already running");
    return;
  }
  // Our TX parity is the active CQ row's slot, falling back to the manual slot.
  const cq = automation.qsos.find((qso) => qso.kind === "calling-cq" && qso.status === "active");
  const slot: TxSlot = cq ? cq.nextSlot : currentSlot;

  surveyActive = true;
  surveySlot = slot;
  surveyStartSec = Math.floor(Date.now() / 1000);

  // Stop transmitting so the radio can actually hear its own TX slot: drop any
  // armed timer and cancel a queued (not yet keyed) automated transmit.
  clearAutomationTimer();
  if (pendingAutomationTx) {
    send({ type: "cancel_transmit" });
    pendingAutomationTx = null;
  }

  // Wait for the next full receive cycle of this parity, plus decode latency.
  const delaySec = secondsUntilNextSlot(slot) + 15 + SURVEY_DECODE_LAG_SECONDS;
  surveyEndSec = surveyStartSec + delaySec;
  appendLog(`[survey] holding TX ~${delaySec}s to listen on the ${slot} slot`);
  updateSurveyButton();
  renderStatusBar();
  if (surveyTimer) {
    clearTimeout(surveyTimer);
  }
  surveyTimer = setTimeout(finishSurvey, delaySec * 1000);
}

function finishSurvey(): void {
  surveyTimer = null;
  const slot = surveySlot;
  surveyActive = false;
  surveySlot = null;

  if (slot) {
    // The held cycle refreshed this slot's plot; auto-pick the widest clear gap.
    const occupied = latestSlotAfs(slot);
    const suggestion = suggestClearAf(occupied, SURVEY_LO_HZ, SURVEY_HI_HZ);
    afInput.setValue(String(suggestion));
    appendLog(`[survey] ${slot} slot updated, clear@${suggestion}Hz (${occupied.length} sigs)`);
  }

  updateSurveyButton();
  renderOccupancyPlots();
  renderStatusBar();
  scheduleAutomation();
}

function cancelSurvey(reason: string): void {
  if (!surveyActive) {
    return;
  }
  if (surveyTimer) {
    clearTimeout(surveyTimer);
    surveyTimer = null;
  }
  surveyActive = false;
  surveySlot = null;
  appendLog(`[survey] aborted (${reason})`);
  updateSurveyButton();
  renderStatusBar();
}

function updateSurveyButton(): void {
  if (surveyActive) {
    surveyButton.setContent("SURVEYING… (CANCEL TX to stop)");
    surveyButton.style.bg = "red";
  } else {
    surveyButton.setContent("Survey TX slot (find clear freq)");
    surveyButton.style.bg = "cyan";
  }
  screen.render();
}

// --- command dialogs ------------------------------------------------------

let dialogOpen = false;

// Modal form: a labelled textbox per field plus OK/Cancel. Pre-filled values
// are shown so the operator can accept or edit them.
function openDialog(
  title: string,
  fields: Array<{ name: string; label: string; value: string }>,
  onSubmit: (values: Record<string, string>) => void
): void {
  if (dialogOpen) {
    return;
  }
  dialogOpen = true;

  const dialog = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: 56,
    height: fields.length * 3 + 6,
    border: { type: "line" },
    label: ` ${title} `,
    tags: true,
    style: { border: { fg: "cyan" } }
  });

  const inputs = fields.map((field, index) => {
    blessed.text({ parent: dialog, top: index * 3, left: 2, content: `${field.label}:` });
    return blessed.textbox({
      parent: dialog,
      top: index * 3 + 1,
      left: 2,
      width: "92%",
      height: 1,
      inputOnFocus: true,
      mouse: true,
      keys: true,
      style: { bg: "black", focus: { bg: "blue" } },
      value: field.value
    });
  });

  const onEsc = (): void => close();
  function close(): void {
    screen.unkey("escape", onEsc);
    dialog.destroy();
    dialogOpen = false;
    decodeList.focus();
    screen.render();
  }
  function submit(): void {
    const values: Record<string, string> = {};
    fields.forEach((field, index) => {
      values[field.name] = inputs[index]!.getValue().trim();
    });
    close();
    onSubmit(values);
  }

  const ok = blessed.button({
    parent: dialog,
    bottom: 1,
    left: 2,
    width: 10,
    height: 1,
    content: "[ OK ]",
    mouse: true,
    align: "center",
    style: { fg: "black", bg: "green", focus: { bg: "blue" } }
  });
  const cancel = blessed.button({
    parent: dialog,
    bottom: 1,
    left: 14,
    width: 12,
    height: 1,
    content: "[Cancel]",
    mouse: true,
    align: "center",
    style: { fg: "black", bg: "red", focus: { bg: "blue" } }
  });
  ok.on("press", submit);
  cancel.on("press", close);
  ok.key(["enter", "space"], submit);
  cancel.key(["enter", "space"], close);

  // Enter advances to the next field; from the last field it moves to OK.
  inputs.forEach((input, index) => {
    input.on("submit", () => {
      focusDialogField(inputs[index + 1] ?? ok);
      screen.render();
    });
  });

  screen.key("escape", onEsc);
  focusDialogField(inputs[0] ?? ok);
  screen.render();
}

type ReadingTextbox = blessed.Widgets.TextboxElement & { _reading?: boolean };
type InputTrapCandidate = blessed.Widgets.BlessedElement & {
  _reading?: boolean;
  options?: { inputOnFocus?: boolean };
};

function focusComposeInput(input: blessed.Widgets.TextboxElement): void {
  const reader = input as ReadingTextbox;
  if (screen.focused !== input) {
    focusFieldWithoutInputTrap(input);
  }
  if (!reader._reading) {
    input.readInput();
  }
  screen.render();
}

function focusDialogField(field: blessed.Widgets.BlessedElement): void {
  focusFieldWithoutInputTrap(field);
}

// Focus a field, defeating blessed's inputOnFocus "focus trap": a textbox that
// is still reading rewinds focus back to itself on blur, which can instantly
// blur the field we are trying to focus. Disabling inputOnFocus on the mid-read
// textbox while we take focus stops the rewind; we restore it after.
function focusFieldWithoutInputTrap(field: blessed.Widgets.BlessedElement): void {
  if (screen.focused === field) {
    return;
  }
  const trapped = screen.focused as unknown as { _reading?: boolean; options?: { inputOnFocus?: boolean } } | undefined;
  const breakTrap = !!(trapped && trapped._reading && trapped.options && trapped.options.inputOnFocus);
  if (breakTrap) {
    (trapped as InputTrapCandidate).options!.inputOnFocus = false;
  }
  field.focus();
  if (breakTrap) {
    (trapped as InputTrapCandidate).options!.inputOnFocus = true;
  }
}

function openSaveDialog(): void {
  openDialog(
    "save config",
    [
      { name: "deviceId", label: "device id", value: lastDeviceId != null ? String(lastDeviceId) : "" },
      { name: "callsign", label: "callsign", value: myCall },
      { name: "grid", label: "grid", value: myGrid },
      { name: "catMode", label: "cat mode (rigctld|dummy)", value: "rigctld" },
      { name: "catPort", label: "cat port", value: "4532" }
    ],
    (values) => {
      const deviceId = Number(values.deviceId);
      if (!Number.isInteger(deviceId) || !values.callsign || !values.grid || !values.catMode) {
        appendLog("save: device id, callsign, grid, and cat mode are required");
        return;
      }
      send({
        type: "save_config",
        session: {
          mode: "FT8",
          device: { id: deviceId },
          callsign: values.callsign,
          grid: values.grid,
          cat: { mode: values.catMode, port: values.catPort ? Number(values.catPort) : 4532 }
        }
      });
      appendLog(`[save] device=${deviceId} ${values.callsign} ${values.grid} ${values.catMode}`);
    }
  );
}

// Operating (dial) frequency: entered manually because CAT reports the wrong
// band on this setup. Stored in Hz; logged with each QSO and used for export.
function openFreqDialog(): void {
  openDialog(
    "operating frequency",
    [{ name: "mhz", label: "dial freq MHz (e.g. 14.074)", value: dialFreqHz ? (dialFreqHz / 1e6).toFixed(3) : "" }],
    (values) => {
      const mhz = Number(values.mhz);
      if (!Number.isFinite(mhz) || mhz <= 0) {
        appendLog("freq: enter a positive frequency in MHz (e.g. 14.074)");
        return;
      }
      setDialFreqHz(Math.round(mhz * 1e6));
      const band = bandForMHz(mhz);
      appendLog(`[freq] operating dial freq = ${mhz.toFixed(3)} MHz${band ? ` (${band})` : " (out of ham band?)"}`);
    }
  );
}

function defaultExportPath(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return join(process.cwd(), "data", `digi-dx-${stamp}.adi`);
}

function openExportDialog(): void {
  openDialog(
    "export ADIF",
    [{ name: "path", label: "output .adi path", value: defaultExportPath() }],
    (values) => {
      if (!values.path) {
        appendLog("export: output path is required");
        return;
      }
      void exportAdif(values.path);
    }
  );
}

async function exportAdif(path: string): Promise<void> {
  try {
    const entries = await readQsoLog();
    if (entries.length === 0) {
      appendLog("[export] no logged QSOs to export");
      return;
    }
    const missingFreqCount = entries.filter((entry) => entry.dialFreqHz == null).length;
    await writeFile(path, buildAdif(entries), "utf8");
    appendLog(
      `[export] wrote ${entries.length} QSO${entries.length === 1 ? "" : "s"} to ${path}` +
        (missingFreqCount > 0 ? ` (${missingFreqCount} without freq)` : "")
    );
  } catch (error) {
    appendLog(`[export error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- websocket event handling ---------------------------------------------

ws.on("open", () => {
  appendLog(`connected to ${url}`);
  decodeList.focus();
  screen.render();
});

ws.on("error", (error) => {
  appendLog(`[connection error] ${error.message}`);
});

ws.on("close", () => {
  appendLog("connection closed");
  screen.render();
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  handleMessage(msg);
});

function handleMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "status": {
      const session = msg.session as Record<string, unknown>;
      const tx = msg.tx as Record<string, unknown>;
      const control = msg.control as Record<string, unknown>;
      if (typeof session.callsign === "string") {
        myCall = session.callsign;
      }
      if (typeof session.grid === "string") {
        myGrid = session.grid;
      }
      const device = session.device as { id?: number } | null;
      if (device && typeof device.id === "number") {
        lastDeviceId = device.id;
      }
      controlHeld = control.held === true;
      controlMine = control.byThisClient === true;
      sessionActive = session.active === true;
      statusBase =
        `{bold}active{/bold}=${session.active} device=${(session.device as { id?: number } | null)?.id ?? "-"} ` +
        `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} call=${session.callsign ?? "-"} grid=${session.grid ?? "-"}  ||  ` +
        `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"}  ||  control held=${control.held} mine=${control.byThisClient}`;
      updateTxState((tx.state as typeof latestTxState) ?? "idle");
      renderSessionButton();
      renderStatusBar();
      break;
    }
    case "decode": {
      const record: DecodeRecord = {
        ts: msg.ts as number,
        snr: msg.snr as number,
        dt: msg.dt as number,
        af: msg.af as number,
        message: msg.message as string
      };
      decodes.push(record);
      appendBandDecode(record);
      screen.render();

      // Occupied-frequency info and the per-slot plots depend on decodes.
      updateAfWarning();
      renderOccupancyPlots();

      // Only touch the scheduler when a decode actually advances a QSO. An
      // unrelated decode must not re-arm (or re-fire) the active transmission,
      // e.g. it must not keep re-triggering CQ while we wait for a reply.
      const events = automation.handleDecode(record, myCall, myGrid);
      if (events.length > 0) {
        handleQsoEvents(events);
        // A live QSO beats surveying: if a caller just answered, stop holding.
        cancelSurvey("answering caller");
        scheduleAutomation();
      }
      break;
    }
    case "tx": {
      appendLog(`[tx] af=${msg.af} ${msg.message}`);
      appendBandTx(msg.ts as number, msg.af as number, msg.message as string);
      if (manualOverridePending) {
        manualOverridePending = false;
        pendingAutomationTx = null;
        scheduleAutomation();
        break;
      }
      const result = automation.confirmTransmission(pendingAutomationTx, {
        ts: msg.ts as number,
        af: msg.af as number,
        message: msg.message as string
      });
      if (result.matched) {
        pendingAutomationTx = null;
      }
      if (result.events.length > 0) {
        handleQsoEvents(result.events);
      }
      scheduleAutomation();
      break;
    }
    case "tx_update":
      appendLog(`[tx_update] state=${msg.state} af=${msg.af ?? "-"} slot=${msg.slot ?? "-"} msg=${msg.message ?? "-"}`);
      updateTxState((msg.state as typeof latestTxState) ?? latestTxState);
      break;
    case "log":
      appendLog(`[${msg.level}] ${msg.message}`);
      break;
    case "error": {
      const code = String(msg.code);
      if (code === "CONTROL_REQUIRED" || code === "CONTROL_UNAVAILABLE") {
        appendLog("You do not have control (another client holds it)");
      } else {
        appendLog(`[error] ${code}: ${msg.message}${msg.details ? ` ${JSON.stringify(msg.details)}` : ""}`);
      }
      if (pendingAutomationTx) {
        // Do not count this as an attempt; leave the QSO active and retry later.
        pendingAutomationTx = null;
        scheduleAutomation();
      }
      break;
    }
    case "config":
      appendLog(`[config] complete=${msg.complete} ${JSON.stringify(msg.session ?? msg.missing ?? "")}`);
      break;
    case "audio_devices":
      appendLog("[audio_devices]");
      for (const device of msg.devices as Array<Record<string, unknown>>) {
        appendLog(`  ${device.id}: ${device.name} (rate=${device.defaultSampleRate})`);
      }
      break;
    default:
      appendLog(`[${String(msg.type)}] ${JSON.stringify(msg)}`);
  }
}

// Seed the worked-callsign set from the persisted log so already-worked
// stations are greyed in Band Activity from the first decode.
async function loadWorkedCalls(): Promise<void> {
  try {
    const entries = await readQsoLog();
    for (const entry of entries) {
      if (entry.theirCall) {
        workedCalls.add(entry.theirCall.toUpperCase());
      }
    }
    appendLog(`[qso-log] ${workedCalls.size} worked callsign(s) loaded`);
  } catch (error) {
    appendLog(`[qso-log error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadStoredDialFreq(): Promise<void> {
  try {
    const state = await readTuiState();
    if (state.dialFreqHz != null) {
      dialFreqHz = state.dialFreqHz;
      appendLog(`[freq] restored dial freq = ${(dialFreqHz / 1e6).toFixed(3)} MHz`);
      renderStatusBar();
      return;
    }

    const entries = await readQsoLog();
    for (let index = entries.length - 1; index >= 0; index--) {
      const loggedFreq = entries[index]!.dialFreqHz;
      if (loggedFreq != null) {
        setDialFreqHz(loggedFreq);
        appendLog(`[freq] restored last logged dial freq = ${(loggedFreq / 1e6).toFixed(3)} MHz`);
        return;
      }
    }
  } catch (error) {
    appendLog(`[state error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

setInterval(() => {
  renderOccupancyPlots();
  renderStatusBar();
}, 500);
void loadStoredDialFreq();
void loadWorkedCalls();
renderOccupancyPlots();
renderQsoList();
screen.render();
