import blessed from "blessed";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "../core/daemon-client.js";
import { appendQsoLog, qsoLogPathFor, readQsoLog } from "./qso-log.js";
import { readTuiState, writeTuiState } from "./tui-state.js";
import { bandForMHz, buildAdif } from "./adif.js";
import {
  findOccupiedAf,
  messageForQso,
  renderOccupancyBar,
  slotFromTimestamp,
  type DecodeRecord,
  type QsoRecord,
  type TxSlot
} from "../core/qso.js";
import type { EngineKind } from "../core/protocol.js";
import type { SlotClock } from "../core/slot-clock.js";
import { gridFrom, latestSlotAfs, senderOf } from "../core/view-model.js";
import {
  createOperatorController,
  type ControllerState,
  type QsoLogStore,
  type StateStore
} from "../core/controller.js";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8788";
const token = process.env.DIGI_DX_AUTH_TOKEN;

// The engine owns all QSO orchestration; the TUI only renders its ControllerState
// and routes input to its methods. The one thing the TUI reads straight off the
// wire is the raw decode/tx stream, because Band Activity is an append-driven
// event log, not a snapshot — so it subscribes to the shared daemon client for
// those rows while the controller (sharing that client) does the automation.
const client = new DaemonClient({ url, token, logger: (message) => appendLog(message) });

const qsoLog: QsoLogStore = {
  append: (entry, engine: EngineKind) => appendQsoLog(entry, qsoLogPathFor(engine)),
  readAll: () => readQsoLog()
};
const stateStore: StateStore = {
  read: () => readTuiState(),
  write: (patch) => writeTuiState({ dialFreqHz: patch.dialFreqHz ?? null })
};
const controller = createOperatorController({
  client,
  log: qsoLog,
  state: stateStore,
  token,
  onLog: (_level, text) => appendLog(text),
  bandForMHz
});

// The latest engine snapshot, refreshed on every controller change. All render
// functions read from it rather than from any local automation state.
let state: ControllerState = controller.state;

function send(command: Parameters<DaemonClient["send"]>[0]): void {
  if (!client.send(command)) {
    appendLog("not connected yet");
  }
}

function clock(): SlotClock | null {
  return state.clock;
}

// --- local render state ----------------------------------------------------

// Band Activity's own decode buffer, fed by the raw decode stream. Kept separate
// from the engine's buffer so the append-driven list and occupancy plots stay
// exactly as they were.
const decodes: DecodeRecord[] = [];

type BandRow = { kind: "decode"; decode: DecodeRecord } | { kind: "sep" } | { kind: "tx" };
const bandRows: BandRow[] = [];
let lastBandPeriod: number | null = null;

let statusBase = "connecting...";
let selectedQsoId: string | null = null;
let lastDeviceId: number | null = null;

const PLOT_WIDTH = 24;
const SURVEY_LO_HZ = 300;
const SURVEY_HI_HZ = 2700;

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

blessed.text({ parent: composePanel, top: 0, left: 1, content: "AF:" });
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
  const af = Number(afInput.getValue());
  if (Number.isInteger(af)) {
    controller.setAf(af);
  }
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
surveyButton.on("press", () => controller.survey());

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
slotButton.on("press", () => {
  controller.setSlot(state.af.slot === "even" ? "odd" : "even");
});

const targetLabel = blessed.text({
  parent: composePanel,
  top: 10,
  left: 1,
  content: "target callsign (dbl-click a decode):"
});
void targetLabel;
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

// Halt / resume. Halting cancels the current TX and disables automation (the
// web client's model); pressing it again re-enables and resumes paused QSOs.
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
  if (state.tx.enabled) {
    controller.haltTx();
  } else {
    controller.setTxEnabled(true);
  }
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
opButton(20, 1, "Resume", () => actOnSelected("resume"));
opButton(20, "48%", "Complete", () => actOnSelected("complete"));
opButton(21, 1, "Abandon", () => {
  const id = selectedQsoId;
  if (id) {
    controller.qsoAction(id, "abandon");
    selectedQsoId = null;
  }
});
opButton(21, "48%", "Retry", () => actOnSelected("retry"));
opButton(22, 1, "Prev step", () => actOnSelected("prevStep"));
opButton(22, "48%", "Next step", () => actOnSelected("nextStep"));
opButton(23, 1, "Up", () => actOnSelected("moveUp"));
opButton(23, "48%", "Down", () => actOnSelected("moveDown"));

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

const commandButtons: Array<{ id?: string; label: string; run: () => void }> = [
  { id: "session", label: "▶ start", run: toggleSession },
  { label: "release", run: () => controller.releaseControl() },
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

// --- control workflow -----------------------------------------------------

function toggleSession(): void {
  if (state.station.sessionActive) {
    controller.stopSession();
  } else {
    controller.startSession();
  }
}

function renderSessionButton(): void {
  if (!sessionButton) {
    return;
  }
  const active = state.station.sessionActive;
  const complete = state.setup.complete;
  sessionButton.setContent(active ? "■ stop" : complete ? "▶ start" : "▶ setup first");
  sessionButton.style.bg = active ? "red" : complete ? "green" : "yellow";
  sessionButton.style.fg = "black";
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
  if (doubleClick) {
    replyToDecode(record);
  }
  screen.render();
});

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
qsoList.key(["u", "S-up"], () => actOnSelected("moveUp"));
qsoList.key(["d", "S-down"], () => actOnSelected("moveDown"));

// --- input actions (routed to the controller) -----------------------------

function callCq(): void {
  controller.callCq(state.af.slot);
}

function replyToTarget(): void {
  const call = targetInput.getValue().trim().toUpperCase();
  if (!call) {
    appendLog("enter a target callsign (or double-click a decode)");
    return;
  }
  targetInput.clearValue();
  controller.replyToCall(call);
}

function replyToDecode(record: DecodeRecord): void {
  const sender = senderOf(record.message);
  if (!sender) {
    appendLog("selected decode has no sender callsign");
    return;
  }
  // The controller derives the reply slot and their grid from its own decode
  // buffer, so the TUI only has to name the station.
  controller.replyToCall(sender);
}

function actOnSelected(action: Parameters<typeof controller.qsoAction>[1]): void {
  if (selectedQsoId) {
    controller.qsoAction(selectedQsoId, action);
  }
}

// --- rendering ------------------------------------------------------------

const QSO_PALETTE = ["cyan", "magenta", "green", "blue", "red", "white"];
const qsoColors = new Map<string, string>();
let nextQsoColor = 0;
function colorForQso(id: string): string {
  let color = qsoColors.get(id);
  if (!color) {
    color = QSO_PALETTE[nextQsoColor % QSO_PALETTE.length]!;
    nextQsoColor++;
    qsoColors.set(id, color);
  }
  return color;
}

function mentionsMyCall(message: string): boolean {
  const myCall = state.station.call;
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
  if (mentionsMyCall(message)) {
    return `{black-fg}{yellow-bg}${line}{/yellow-bg}{/black-fg}`;
  }
  const sender = senderOf(message);
  if (sender) {
    const qso = state.qsos.active.find(
      (candidate) => candidate.kind === "standard" && candidate.theirCall === sender && candidate.status !== "complete"
    );
    if (qso) {
      const color = colorForQso(qso.id);
      return `{black-fg}{${color}-bg}${line}{/${color}-bg}{/black-fg}`;
    }
    if (state.workedCalls.has(sender)) {
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

function appendBandTx(ts: number, af: number, message: string): void {
  pushBandSeparator(Math.floor(ts / 15) * 15, true);
  bandRows.push({ kind: "tx" });
  decodeList.addItem(`{cyan-fg}» TX ${String(af).padStart(5)}  ${message}{/cyan-fg}`);
  decodeList.scrollTo(bandRows.length);
}

// --- cycle clock ----------------------------------------------------------

function clockSegment(): string {
  const c = clock();
  if (!c) {
    return "{grey-fg}awaiting slot clock{/grey-fg}";
  }
  const nowSec = Math.floor(c.now() / 1000);
  const slotSeconds = c.spec.slotMs / 1000;
  const parity = slotFromTimestamp(nowSec);
  const remain = slotSeconds - (nowSec % slotSeconds);
  let tx: string;
  if (state.survey.active) {
    const left = Math.max(0, state.survey.endSec - nowSec);
    tx = `{cyan-fg}{bold}SURVEY ${state.survey.slot} t-${left}s{/bold}{/cyan-fg}`;
  } else if (state.tx.state === "active") {
    tx = "{red-fg}{bold}TX{/bold}{/red-fg}";
  } else if (state.tx.state === "pending") {
    tx = "{yellow-fg}TX-arm{/yellow-fg}";
  } else {
    tx = "{green-fg}RX{/green-fg}";
  }
  return `cycle={bold}${parity}{/bold} t-${String(remain).padStart(2)}s ${tx}`;
}

function renderStatusBar(): void {
  const dialFreqHz = state.station.dialFreqHz;
  const qrg = dialFreqHz
    ? `{green-fg}${(dialFreqHz / 1e6).toFixed(3)}MHz{/green-fg}`
    : "{yellow-fg}unset{/yellow-fg}";
  const demo = state.station.demo ? "{black-fg}{yellow-bg} DEMO — NOT ON THE AIR {/}  ||  " : "";
  statusBar.setContent(`${demo}${statusBase}  ||  ${clockSegment()}  ||  QRG=${qrg}`);
}

// --- qso list -------------------------------------------------------------

function formatQsoRow(qso: QsoRecord, priority: number): string {
  const who = qso.theirCall ?? "CQ";
  const attempts = qso.attempts[qso.step] ?? 0;
  const preview = messageForQso(qso) ?? "-";
  const lastRx = qso.rxMessages[qso.rxMessages.length - 1]?.message ?? "-";
  const note = qso.note ? ` (${qso.note})` : "";
  const color = colorForQso(qso.id);
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

let renderedActive: QsoRecord[] = [];

function renderQsoList(): void {
  cqIndicator.setContent(
    state.qsos.callingCq
      ? "{green-bg}{black-fg} ● CALLING CQ {/black-fg}{/green-bg}"
      : "{grey-fg}○ CQ idle — press Call CQ to start{/grey-fg}"
  );

  renderedActive = state.qsos.active.filter((qso) => qso.kind !== "calling-cq" && qso.status !== "complete");
  qsoList.setItems(renderedActive.map((qso, index) => formatQsoRow(qso, index + 1)));
  if (selectedQsoId) {
    const index = renderedActive.findIndex((qso) => qso.id === selectedQsoId);
    if (index >= 0) {
      qsoList.select(index);
    } else {
      selectedQsoId = null;
    }
  }

  completedPanel.setItems(state.qsos.completed.map(formatCompletedRow));
}

// --- occupancy plots + AF warning -----------------------------------------

function updateAfWarning(): void {
  const af = Number(afInput.getValue());
  if (!Number.isInteger(af)) {
    afWarning.setContent("");
    return;
  }
  const match = findOccupiedAf(decodes, af, state.af.slot, 50, 2);
  afWarning.setContent(
    match ? `{yellow-fg}occupied +/-50Hz: ${match.decode.af} ${match.decode.message}{/yellow-fg}` : ""
  );
}

function renderOccupancyPlots(): void {
  const afValue = Number(afInput.getValue());
  const mark = Number.isInteger(afValue) ? afValue : undefined;
  const txSlot = state.af.slot;
  const even = renderOccupancyBar(latestSlotAfs(decodes, "even"), SURVEY_LO_HZ, SURVEY_HI_HZ, PLOT_WIDTH, mark);
  const odd = renderOccupancyBar(latestSlotAfs(decodes, "odd"), SURVEY_LO_HZ, SURVEY_HI_HZ, PLOT_WIDTH, mark);
  evenPlot.setContent(`${txSlot === "even" ? "{bold}E*{/bold}" : "E "}|${even}|`);
  oddPlot.setContent(`${txSlot === "odd" ? "{bold}O*{/bold}" : "O "}|${odd}|`);
}

function updateSurveyButton(): void {
  if (state.survey.active) {
    surveyButton.setContent("SURVEYING… (CANCEL TX to stop)");
    surveyButton.style.bg = "red";
  } else {
    surveyButton.setContent("Survey TX slot (find clear freq)");
    surveyButton.style.bg = "cyan";
  }
}

function renderSlotButton(): void {
  slotButton.setContent(`slot: ${state.af.slot} (click to toggle)`);
}

// Redraw everything that derives from a controller snapshot.
function renderFromState(): void {
  renderQsoList();
  renderSessionButton();
  renderSlotButton();
  updateSurveyButton();
  updateAfWarning();
  renderOccupancyPlots();
  renderStatusBar();
  screen.render();
}

// --- command dialogs ------------------------------------------------------

let dialogOpen = false;

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
      { name: "callsign", label: "callsign", value: state.station.call },
      { name: "grid", label: "grid", value: state.station.grid },
      { name: "catMode", label: "cat mode (rigctld|dummy)", value: "rigctld" },
      { name: "catPort", label: "cat port", value: "4532" }
    ],
    (values) => {
      const deviceId = Number(values.deviceId);
      if (!Number.isInteger(deviceId) || !values.callsign || !values.grid || !values.catMode) {
        appendLog("save: device id, callsign, grid, and cat mode are required");
        return;
      }
      controller.saveSetup({
        deviceId,
        callsign: values.callsign!,
        grid: values.grid!,
        catMode: values.catMode!,
        catPort: values.catPort ? Number(values.catPort) : 4532
      });
      appendLog(`[save] device=${deviceId} ${values.callsign} ${values.grid} ${values.catMode}`);
    }
  );
}

function openFreqDialog(): void {
  openDialog(
    "operating frequency",
    [
      {
        name: "mhz",
        label: "dial freq MHz (e.g. 14.074)",
        value: state.station.dialFreqHz ? (state.station.dialFreqHz / 1e6).toFixed(3) : ""
      }
    ],
    (values) => {
      const mhz = Number(values.mhz);
      if (!Number.isFinite(mhz) || mhz <= 0) {
        appendLog("freq: enter a positive frequency in MHz (e.g. 14.074)");
        return;
      }
      controller.setDialFreq(mhz);
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

// --- raw daemon stream (Band Activity rendering only) ---------------------

client.on("open", () => {
  appendLog(`connected to ${url}`);
  decodeList.focus();
  screen.render();
});

client.on("decode", (msg) => {
  const record: DecodeRecord = { ts: msg.ts, snr: msg.snr, dt: msg.dt, af: msg.af, message: msg.message };
  decodes.push(record);
  appendBandDecode(record);
  updateAfWarning();
  renderOccupancyPlots();
  screen.render();
});

client.on("tx", (msg) => {
  appendBandTx(msg.ts, msg.af, msg.message);
  screen.render();
});

client.on("tx_update", (msg) => {
  appendLog(`[tx_update] state=${msg.state} af=${msg.af ?? "-"} slot=${msg.slot ?? "-"} msg=${msg.message ?? "-"}`);
});

client.on("audio_devices", (msg) => {
  appendLog("[audio_devices]");
  for (const device of msg.devices) {
    appendLog(`  ${device.id}: ${device.name} (rate=${device.defaultSampleRate})`);
  }
});

// Track the device id for the save dialog pre-fill, and the status one-liner.
client.on("status", (msg) => {
  const { session, tx, control } = msg;
  if (session.device) {
    lastDeviceId = session.device.id;
  }
  statusBase =
    `{bold}active{/bold}=${session.active} device=${session.device?.id ?? "-"} ` +
    `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} call=${session.callsign ?? "-"} grid=${session.grid ?? "-"}  ||  ` +
    `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"}  ||  control held=${control.held} mine=${control.byThisClient}`;
});

client.on("config", (msg) => {
  if (msg.session?.device?.id != null) {
    lastDeviceId = msg.session.device.id;
  }
});

// Band Activity persists across reconnects (its row->decode mapping must stay in
// sync with the blessed list); the engine resets its own state on close and the
// status bar follows via onChange.

// The engine drives everything else.
controller.onChange((next) => {
  state = next;
  renderFromState();
});

setInterval(renderStatusBar, 500);
setInterval(() => screen.render(), 500);

renderFromState();
screen.render();
controller.start();
