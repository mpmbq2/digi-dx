import blessed from "blessed";
import { WebSocket } from "ws";
import { appendQsoLog } from "./qso-log.js";
import {
  findOccupiedAf,
  messageForQso,
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
} from "./qso.js";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8787";
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

const decodeList = blessed.list({
  top: 3,
  left: 0,
  width: "55%",
  height: "45%",
  border: { type: "line" },
  label: " band activity (click a row to draft a reply) ",
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

// The QSO panel holds a CQ indicator, the active QSO list, and a completed list.
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
  height: "48%",
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

const completedList = blessed.list({
  parent: qsoArea,
  top: "50%",
  left: 0,
  width: "100%",
  height: "48%",
  border: { type: "line" },
  label: " completed ",
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
  value: "1000"
});
afInput.on("submit", () => {
  updateAfWarning();
  renderOccupancyPlots();
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

const messageLabel = blessed.text({ parent: composePanel, top: 10, left: 1, content: "message:" });
const messageInput = blessed.textbox({
  parent: composePanel,
  top: 11,
  left: 1,
  width: "90%",
  height: 3,
  border: { type: "line" },
  inputOnFocus: true,
  mouse: true
});

const macroBar = blessed.box({ parent: composePanel, top: 14, left: 1, width: "90%", height: 3 });
const cqButton = blessed.button({
  parent: macroBar,
  top: 0,
  left: 0,
  width: "50%-1",
  height: 3,
  border: { type: "line" },
  mouse: true,
  align: "center",
  content: "draft CQ"
});
cqButton.on("press", () => {
  messageInput.setValue(`CQ ${myCall || "MYCALL"} ${myGrid || "GRID"}`);
  screen.render();
});

const rr73Button = blessed.button({
  parent: macroBar,
  top: 0,
  left: "50%",
  width: "50%-1",
  height: 3,
  border: { type: "line" },
  mouse: true,
  align: "center",
  content: "draft RR73"
});
rr73Button.on("press", () => {
  const current = messageInput.getValue().trim();
  const target = current.split(/\s+/)[0];
  if (target) {
    messageInput.setValue(`${target} ${myCall || "MYCALL"} RR73`);
    screen.render();
  }
});

const sendButton = blessed.button({
  parent: composePanel,
  top: 17,
  left: 1,
  width: "44%",
  height: 3,
  border: { type: "line" },
  mouse: true,
  align: "center",
  content: "TRANSMIT",
  style: { fg: "black", bg: "green" }
});
sendButton.on("press", () => {
  const af = Number(afInput.getValue());
  const message = messageInput.getValue().trim();
  if (!Number.isInteger(af) || af < 200 || af > 3000) {
    appendLog("invalid AF, must be an integer 200-3000");
    return;
  }
  if (!message) {
    appendLog("message is empty");
    return;
  }
  // Manual transmit is a one-shot override: pause automation until the next
  // matching daemon tx event (or until the pending state clears).
  cancelSurvey("manual transmit");
  manualOverridePending = true;
  pendingAutomationTx = null;
  clearAutomationTimer();
  send({ type: "transmit", af, slot: currentSlot, message });
});

const cancelButton = blessed.button({
  parent: composePanel,
  top: 17,
  left: "48%",
  width: "44%",
  height: 3,
  border: { type: "line" },
  mouse: true,
  align: "center",
  content: "CANCEL TX",
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

blessed.text({ parent: composePanel, top: 20, left: 1, content: "-- qso automation --" });

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
    style: { fg: "white", focus: { bg: "blue" }, hover: { bg: "blue" } }
  });
  button.on("press", handler);
}

opButton(21, 1, "Call CQ", callCq);
opButton(21, "48%", "Reply QSO", replyToSelectedDecode);
opButton(22, 1, "Resume", () => actOnSelected((qso) => automation.resume(qso.id)));
opButton(22, "48%", "Complete", () => {
  const qso = selectedQso();
  if (qso) {
    handleQsoEvents(automation.complete(qso.id));
    scheduleAutomation();
  }
});
opButton(23, 1, "Abandon", () => {
  const qso = selectedQso();
  if (qso) {
    automation.abandon(qso.id);
    selectedQsoId = null;
    scheduleAutomation();
  }
});
opButton(23, "48%", "Retry", () => actOnSelected((qso) => automation.resetAttempts(qso.id)));
opButton(24, 1, "Prev step", () => actOnSelected((qso) => automation.previousStep(qso.id)));
opButton(24, "48%", "Next step", () => actOnSelected((qso) => automation.nextStep(qso.id)));
opButton(25, 1, "Up", () => moveSelected(-1));
opButton(25, "48%", "Down", () => moveSelected(1));

const logBox = blessed.log({
  top: "73%",
  left: 0,
  width: "100%",
  bottom: 3,
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

// One button per daemon command. Commands that need arguments (save) open a
// dialog pre-filled from current status; the rest send immediately.
const commandButtons: Array<{ label: string; run: () => void }> = [
  { label: "claim", run: () => send({ type: "claim_control", ...(token ? { token } : {}) }) },
  { label: "release", run: () => send({ type: "release_control" }) },
  { label: "start", run: () => send({ type: "start_session" }) },
  { label: "stop", run: () => send({ type: "stop_session" }) },
  { label: "status", run: () => send({ type: "get_status" }) },
  { label: "config", run: () => send({ type: "get_config" }) },
  { label: "devices", run: () => send({ type: "list_audio_devices" }) },
  { label: "save…", run: openSaveDialog }
];
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
    style: { fg: "white", focus: { bg: "blue" }, hover: { bg: "blue" } }
  });
  button.on("press", command.run);
});

screen.append(statusBar);
screen.append(decodeList);
screen.append(qsoArea);
screen.append(composePanel);
screen.append(logBox);
screen.append(commandBar);

screen.key(["C-c"], () => process.exit(0));
screen.key(["tab"], () => screen.focusNext());
screen.key(["S-tab"], () => screen.focusPrevious());

decodeList.on("select", (_item, index) => {
  const row = bandRows[index];
  if (!row || row.kind !== "decode") {
    return;
  }
  const record = row.decode;
  afInput.setValue(String(record.af));
  const decodeSlot = record.ts % 30 === 0 ? "even" : "odd";
  currentSlot = decodeSlot === "even" ? "odd" : "even";
  slotButton.setContent(`slot: ${currentSlot} (click to toggle)`);
  messageInput.setValue(draftReply(record.message));
  updateAfWarning();
  screen.render();
});

decodeList.key(["r"], replyToSelectedDecode);
decodeList.key(["c"], callCq);

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

function draftReply(message: string): string {
  const tokens = message.split(/\s+/);
  const call = myCall || "MYCALL";
  const grid = myGrid || "GRID";
  if (tokens[0] === "CQ") {
    const target = tokens[tokens.length - 2] ?? tokens[1];
    return `${target} ${call} ${grid}`;
  }
  const target = tokens[1] ?? tokens[0];
  return `${target} ${call} ${grid}`;
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

function appendBandDecode(record: DecodeRecord): void {
  pushBandSeparator(Math.floor(record.ts / 15) * 15, false);
  bandRows.push({ kind: "decode", decode: record });
  const time = new Date(record.ts * 1000).toISOString().slice(11, 19);
  const line = `${time} ${String(record.snr).padStart(4)} ${String(record.af).padStart(5)}  ${record.message}`;
  decodeList.addItem(mentionsMyCall(record.message) ? `{black-fg}{yellow-bg}${line}{/yellow-bg}{/black-fg}` : line);
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
  statusBar.setContent(`${statusBase}  ||  ${clockSegment()}`);
  screen.render();
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

function replyToSelectedDecode(): void {
  if (!ensureAutomationIdentity()) {
    return;
  }
  const index = (decodeList as unknown as { selected: number }).selected;
  const row = bandRows[index];
  if (!row || row.kind !== "decode") {
    appendLog("select a decoded CQ row first");
    return;
  }
  const record = row.decode;
  const parsed = parseFt8Message(record.message);
  if (!parsed || parsed.type !== "cq") {
    appendLog("selected decode is not a CQ");
    return;
  }
  const existing = automation.qsos.find(
    (qso) => qso.kind === "standard" && qso.theirCall === parsed.call && qso.status !== "complete"
  );
  if (existing) {
    appendLog(`QSO already exists for ${parsed.call}`);
    selectQso(existing.id);
    return;
  }
  const qso = automation.createReplyToCq(record, myCall, myGrid, "top");
  if (!qso) {
    appendLog("could not create reply QSO");
    return;
  }
  appendLog(`[qso] reply to ${qso.theirCall}`);
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
  const base = `${priority} ${qso.status} ${who} ${qso.step} att=${attempts} tx>${preview} rx>${lastRx}${note}`;
  switch (qso.status) {
    case "timed_out":
      return `{red-fg}${base}{/red-fg}`;
    case "paused":
    case "stopped":
      return `{yellow-fg}${base}{/yellow-fg}`;
    default:
      return base;
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

  completedList.setItems(automation.qsos.filter((qso) => qso.status === "complete").map(formatCompletedRow));

  screen.render();
}

function handleQsoEvents(events: QsoAutomationEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "qso_created":
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
  const entry = automation.toLogEntry(qso, reason);
  if (!entry) {
    return;
  }
  loggedQsoIds.add(qso.id);
  try {
    await appendQsoLog(entry);
    appendLog(`[qso-log] wrote ${entry.theirCall}`);
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
      (inputs[index + 1] ?? ok).focus();
      screen.render();
    });
  });

  screen.key("escape", onEsc);
  (inputs[0] ?? ok).focus();
  screen.render();
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
      statusBase =
        `{bold}active{/bold}=${session.active} device=${(session.device as { id?: number } | null)?.id ?? "-"} ` +
        `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} call=${session.callsign ?? "-"} grid=${session.grid ?? "-"}  ||  ` +
        `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"}  ||  control held=${control.held} mine=${control.byThisClient}`;
      updateTxState((tx.state as typeof latestTxState) ?? "idle");
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
    case "error":
      appendLog(`[error] ${msg.code}: ${msg.message}${msg.details ? ` ${JSON.stringify(msg.details)}` : ""}`);
      if (pendingAutomationTx) {
        // Do not count this as an attempt; leave the QSO active and retry later.
        pendingAutomationTx = null;
        scheduleAutomation();
      }
      break;
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

setInterval(() => {
  renderOccupancyPlots();
  renderStatusBar();
}, 500);
renderOccupancyPlots();
renderQsoList();
screen.render();
