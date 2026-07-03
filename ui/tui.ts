import blessed from "blessed";
import { WebSocket } from "ws";
import { appendQsoLog } from "./qso-log.js";
import {
  findOccupiedAf,
  messageForQso,
  parseFt8Message,
  QsoAutomation,
  secondsUntilNextSlot,
  type AutomationTx,
  type DecodeRecord,
  type QsoAutomationEvent,
  type QsoRecord,
  type TxSlot
} from "./qso.js";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8787";
const token = process.env.DIGI_DX_AUTH_TOKEN;

const decodes: DecodeRecord[] = [];
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
const loggedQsoIds = new Set<string>();

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
    selected: { bg: "blue" }
  }
});

const qsoList = blessed.list({
  top: "48%",
  left: 0,
  width: "55%",
  height: "25%",
  border: { type: "line" },
  label: " active qsos (r=reply c=cq u/d=reorder) ",
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  style: { selected: { bg: "blue" } }
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
  screen.render();
});

const slotButton = blessed.button({
  parent: composePanel,
  top: 4,
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
  screen.render();
});

const messageLabel = blessed.text({ parent: composePanel, top: 7, left: 1, content: "message:" });
const messageInput = blessed.textbox({
  parent: composePanel,
  top: 8,
  left: 1,
  width: "90%",
  height: 3,
  border: { type: "line" },
  inputOnFocus: true,
  mouse: true
});

const macroBar = blessed.box({ parent: composePanel, top: 11, left: 1, width: "90%", height: 3 });
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
  top: 14,
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
  manualOverridePending = true;
  pendingAutomationTx = null;
  clearAutomationTimer();
  send({ type: "transmit", af, slot: currentSlot, message });
});

const cancelButton = blessed.button({
  parent: composePanel,
  top: 14,
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
  pendingAutomationTx = null;
  manualOverridePending = false;
  clearAutomationTimer();
  automation.pauseAll("cancelled");
  renderQsoList();
});

// --- qso automation controls ---------------------------------------------

blessed.text({ parent: composePanel, top: 17, left: 1, content: "-- qso automation --" });

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

opButton(18, 1, "Call CQ", callCq);
opButton(18, "48%", "Reply QSO", replyToSelectedDecode);
opButton(19, 1, "Resume", () => actOnSelected((qso) => automation.resume(qso.id)));
opButton(19, "48%", "Complete", () => {
  const qso = selectedQso();
  if (qso) {
    handleQsoEvents(automation.complete(qso.id));
    scheduleAutomation();
  }
});
opButton(20, 1, "Abandon", () => {
  const qso = selectedQso();
  if (qso) {
    automation.abandon(qso.id);
    selectedQsoId = null;
    scheduleAutomation();
  }
});
opButton(20, "48%", "Retry", () => actOnSelected((qso) => automation.resetAttempts(qso.id)));
opButton(21, 1, "Prev step", () => actOnSelected((qso) => automation.previousStep(qso.id)));
opButton(21, "48%", "Next step", () => actOnSelected((qso) => automation.nextStep(qso.id)));
opButton(22, 1, "Up", () => moveSelected(-1));
opButton(22, "48%", "Down", () => moveSelected(1));

const logBox = blessed.log({
  top: "73%",
  left: 0,
  width: "100%",
  height: "100%-3-73%",
  border: { type: "line" },
  label: " log ",
  scrollable: true,
  alwaysScroll: true
});

const cmdInput = blessed.textbox({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: { type: "line" },
  label: " command (claim / release / devices / config / save.. / start.. / stop) ",
  inputOnFocus: true,
  mouse: true
});

screen.append(statusBar);
screen.append(decodeList);
screen.append(qsoList);
screen.append(composePanel);
screen.append(logBox);
screen.append(cmdInput);

screen.key(["C-c"], () => process.exit(0));
screen.key(["tab"], () => screen.focusNext());
screen.key(["S-tab"], () => screen.focusPrevious());

cmdInput.key(["enter"], () => {
  const line = cmdInput.getValue().trim();
  cmdInput.clearValue();
  screen.render();
  if (line) {
    runCommand(line);
  }
});

decodeList.on("select", (_item, index) => {
  const record = decodes[index];
  if (!record) {
    return;
  }
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
  const qso = automation.qsos[index];
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
  const qso = automation.createCq(myCall, myGrid, currentSlot, "top");
  appendLog("[qso] calling CQ");
  selectQso(qso.id);
  scheduleAutomation();
}

function replyToSelectedDecode(): void {
  if (!ensureAutomationIdentity()) {
    return;
  }
  const index = (decodeList as unknown as { selected: number }).selected;
  const record = decodes[index];
  if (!record) {
    appendLog("no decode selected");
    return;
  }
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
  const note = qso.note ? ` (${qso.note})` : "";
  const base = `${priority} ${qso.status} ${who} step=${qso.step} att=${attempts} slot=${qso.nextSlot} ${preview}${note}`;
  switch (qso.status) {
    case "timed_out":
      return `{red-fg}${base}{/red-fg}`;
    case "paused":
    case "stopped":
      return `{yellow-fg}${base}{/yellow-fg}`;
    case "complete":
      return `{green-fg}${base}{/green-fg}`;
    default:
      return base;
  }
}

function renderQsoList(): void {
  const rows = automation.qsos.map((qso, index) => formatQsoRow(qso, index + 1));
  qsoList.setItems(rows);
  if (selectedQsoId) {
    const index = automation.qsos.findIndex((qso) => qso.id === selectedQsoId);
    if (index >= 0) {
      qsoList.select(index);
    } else {
      selectedQsoId = null;
    }
  }
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

function scheduleAutomation(): void {
  clearAutomationTimer();
  renderQsoList();
  updateAfWarning();

  if (manualOverridePending || latestTxState === "active") {
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
  if (manualOverridePending || latestTxState === "active") {
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

// --- daemon command parsing (mirrors ui/cli.ts) ---------------------------

function runCommand(line: string): void {
  const [cmd, ...rest] = line.split(/\s+/);

  switch (cmd) {
    case "claim":
      send({ type: "claim_control", ...(token ? { token } : {}) });
      break;
    case "release":
      send({ type: "release_control" });
      break;
    case "devices":
      send({ type: "list_audio_devices" });
      break;
    case "config":
      send({ type: "get_config" });
      break;
    case "status":
      send({ type: "get_status" });
      break;
    case "stop":
      send({ type: "stop_session" });
      break;
    case "save": {
      const [deviceId, callsign, grid, catMode, catPort] = rest;
      if (!deviceId || !callsign || !grid || !catMode) {
        appendLog("usage: save <deviceId> <call> <grid> <catMode:rigctld|dummy> [port=4532]");
        break;
      }
      send({
        type: "save_config",
        session: {
          mode: "FT8",
          device: { id: Number(deviceId) },
          callsign,
          grid,
          cat: { mode: catMode, port: catPort ? Number(catPort) : 4532 }
        }
      });
      break;
    }
    case "start": {
      if (rest.length === 0) {
        send({ type: "start_session" });
        break;
      }
      const [deviceId, callsign, grid, catMode, catPort] = rest;
      if (!deviceId || !callsign || !grid || !catMode) {
        appendLog("usage: start [deviceId] [call] [grid] [catMode:rigctld|dummy] [port=4532]");
        break;
      }
      send({
        type: "start_session",
        session: {
          mode: "FT8",
          device: { id: Number(deviceId) },
          callsign,
          grid,
          cat: { mode: catMode, port: catPort ? Number(catPort) : 4532 }
        }
      });
      break;
    }
    default:
      appendLog(`unknown command '${cmd}'`);
  }
}

// --- websocket event handling ---------------------------------------------

ws.on("open", () => {
  appendLog(`connected to ${url}`);
  cmdInput.focus();
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
      latestTxState = (tx.state as typeof latestTxState) ?? "idle";
      statusBar.setContent(
        `{bold}active{/bold}=${session.active} device=${(session.device as { id?: number } | null)?.id ?? "-"} ` +
          `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} call=${session.callsign ?? "-"} grid=${session.grid ?? "-"}  ||  ` +
          `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"}  ||  control held=${control.held} mine=${control.byThisClient}`
      );
      screen.render();
      if (latestTxState === "idle" && !manualOverridePending) {
        scheduleAutomation();
      }
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
      const time = new Date(record.ts * 1000).toISOString().slice(11, 19);
      const line = `${time} ${String(record.snr).padStart(4)} ${String(record.af).padStart(5)}  ${record.message}`;
      decodeList.addItem(mentionsMyCall(record.message) ? `{black-fg}{yellow-bg}${line}{/yellow-bg}{/black-fg}` : line);
      decodeList.scrollTo(decodes.length);
      screen.render();

      const events = automation.handleDecode(record, myCall, myGrid);
      if (events.length > 0) {
        handleQsoEvents(events);
      }
      // A relevant decode may advance a QSO; reschedule the next automated tx.
      scheduleAutomation();
      break;
    }
    case "tx": {
      appendLog(`[tx] af=${msg.af} ${msg.message}`);
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
      latestTxState = (msg.state as typeof latestTxState) ?? latestTxState;
      if (latestTxState === "idle" && !manualOverridePending) {
        scheduleAutomation();
      }
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

screen.render();
