import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DaemonClient } from "../../core/daemon-client.js";
import type { DaemonCommand } from "../../core/protocol.js";
import { appendQsoLog, readQsoLog } from "../qso-log.js";
import { readTuiState, writeTuiState } from "../tui-state.js";
import { bandForMHz } from "../adif.js";
import {
  QsoAutomation,
  oppositeSlot,
  parseFt8Message,
  secondsUntilNextSlot,
  slotFromTimestamp,
  suggestClearAf,
  type AutomationTx,
  type DecodeRecord,
  type QsoAutomationEvent,
  type QsoRecord,
  type TxSlot
} from "../../core/qso.js";
import {
  annotateDecode,
  buildActiveQsoView,
  buildCompletedView,
  buildRosters,
  cycleParity,
  deriveTxCard,
  gridFrom,
  latestSlotAfs,
  senderOf,
  type AnnotateContext
} from "./view-model.js";
import type { CommandMessage, LogLineView, StateMessage, TxState } from "./protocol.js";

let daemonUrl = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8788";
let token = process.env.DIGI_DX_AUTH_TOKEN;
let webPort = Number(process.env.DIGI_DX_WEB_PORT ?? 8080);
let webHost = process.env.DIGI_DX_WEB_HOST ?? "0.0.0.0";
const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "public");

export interface WebUiServerOptions {
  daemonUrl?: string;
  token?: string;
  webPort?: number;
  webHost?: string;
}

// --- controller state ------------------------------------------------------

const decodes: DecodeRecord[] = [];
const automation = new QsoAutomation();

let myCall = "";
let myGrid = "";
let dialFreqHz: number | null = null;

let controlHeld = false;
let controlMine = false;
let sessionActive = false;
let catConnected = false;

let latestTxState: TxState = "idle";
let pendingAutomationTx: AutomationTx | null = null;
let activeAutomationTx: AutomationTx | null = null;
let scheduledAutomationTx: AutomationTx | null = null;
let automationTimer: NodeJS.Timeout | null = null;
let txEnabled = true;

// Current TX audio frequency and manual slot, mirroring the TUI's AF/slot inputs.
let currentAf = 1000;
let currentSlot: TxSlot = "even";

const loggedQsoIds = new Set<string>();
const workedCalls = new Set<string>();

// Slot survey: hold TX for one receive cycle of our TX parity so the (otherwise
// deaf) TX slot can be observed, then suggest a clear frequency.
const SURVEY_LO_HZ = 300;
const SURVEY_HI_HZ = 2700;
const SURVEY_DECODE_LAG_SECONDS = 5;
let surveyActive = false;
let surveySlot: TxSlot | null = null;
let surveyEndSec = 0;
let surveyTimer: NodeJS.Timeout | null = null;

// Stable per-QSO colour used to tint decodes/roster rows. Yellow is reserved by
// the browser for "replying to me", so it is absent from this palette.
const QSO_PALETTE = ["#34d3d3", "#d96be0", "#7c9cff", "#57c46a", "#f5a742", "#e0607d"];
const qsoColors = new Map<string, string>();
let nextQsoColor = 0;
function colorFor(id: string): string {
  let color = qsoColors.get(id);
  if (!color) {
    color = QSO_PALETTE[nextQsoColor % QSO_PALETTE.length]!;
    nextQsoColor++;
    qsoColors.set(id, color);
  }
  return color;
}

// Recent activity log ring, streamed to the browser.
const logLines: LogLineView[] = [];
function appendLog(level: LogLineView["level"], text: string): void {
  logLines.push({ level, text });
  if (logLines.length > 200) {
    logLines.splice(0, logLines.length - 200);
  }
  broadcastState();
}

// --- daemon connection -----------------------------------------------------

let daemonClient: DaemonClient | null = null;
let controlClaimPending = false;

function daemonSend(command: DaemonCommand): boolean {
  if (!daemonClient || !daemonClient.send(command)) {
    appendLog("warn", "daemon not connected");
    return false;
  }
  return true;
}

function connectDaemon(): void {
  const client = new DaemonClient({
    url: daemonUrl,
    token,
    reconnectMs: 2000,
    logger: (message) => appendLog("error", message)
  });
  daemonClient = client;

  client.on("open", () => appendLog("info", `connected to daemon ${daemonUrl}`));
  client.on("close", () => {
    controlHeld = false;
    controlMine = false;
    controlClaimPending = false;
    sessionActive = false;
    latestTxState = "idle";
    appendLog("warn", "daemon connection closed; retrying in 2s");
  });

  client.on("status", (msg) => {
    const { session, tx, control } = msg;
    const hadControl = controlMine;
    if (session.callsign !== null) {
      myCall = session.callsign;
    }
    if (session.grid !== null) {
      myGrid = session.grid;
    }
    controlHeld = control.held;
    controlMine = control.byThisClient;
    if (controlMine || !controlHeld) {
      controlClaimPending = false;
    }
    sessionActive = session.active;
    catConnected = session.catConnected;
    updateTxState(tx.state);
    if (!hadControl && controlMine) {
      scheduleAutomation();
    }
    broadcastState();
  });

  client.on("decode", (msg) => {
    const record: DecodeRecord = { ts: msg.ts, snr: msg.snr, dt: msg.dt, af: msg.af, message: msg.message };
    decodes.push(record);
    if (decodes.length > 2000) {
      decodes.splice(0, decodes.length - 2000);
    }
    const events = automation.handleDecode(record, myCall, myGrid);
    if (events.length > 0) {
      handleQsoEvents(events);
      cancelSurvey("answering caller");
      scheduleAutomation();
    }
    broadcastState();
  });

  client.on("tx", (msg) => {
    appendLog("tx", `[tx] af=${msg.af} ${msg.message}`);
    const result = automation.confirmTransmission(pendingAutomationTx, { ts: msg.ts, af: msg.af, message: msg.message });
    if (result.matched) {
      activeAutomationTx = pendingAutomationTx;
      pendingAutomationTx = null;
    }
    if (result.events.length > 0) {
      handleQsoEvents(result.events);
    }
    scheduleAutomation();
  });

  client.on("tx_update", (msg) => updateTxState(msg.state));

  client.on("log", (msg) => appendLog(msg.level, `[daemon] ${msg.message}`));

  client.on("daemonError", (msg) => {
    if (msg.code === "CONTROL_REQUIRED" || msg.code === "CONTROL_UNAVAILABLE") {
      controlClaimPending = false;
      appendLog("warn", "control is held by another client");
    } else {
      appendLog("error", `[error] ${msg.code}: ${msg.message}`);
    }
    if (pendingAutomationTx) {
      pendingAutomationTx = null;
      activeAutomationTx = null;
      scheduledAutomationTx = null;
      scheduleAutomation();
    }
  });

  client.on("config", (msg) => appendLog("info", `[config] complete=${msg.complete}`));

  client.connect();
}

// --- QSO event handling / logging ------------------------------------------

function handleQsoEvents(events: QsoAutomationEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "qso_created":
        colorFor(event.qso.id);
        appendLog("qso", `[qso] created ${event.qso.theirCall ?? "CQ"}`);
        break;
      case "qso_updated":
        appendLog("qso", `[qso] ${event.qso.theirCall} ${event.previousStep} -> ${event.qso.step}`);
        break;
      case "qso_completed":
        appendLog("qso", `[qso] complete ${event.qso.theirCall ?? "CQ"} (${event.reason})`);
        void logCompletedQso(event.qso, event.reason);
        break;
      case "qso_timed_out":
        appendLog("qso", `[qso] timed out ${event.qso.theirCall ?? "CQ"} step=${event.qso.step}`);
        break;
      case "cq_stopped":
        appendLog("qso", "[qso] CQ stopped after reply");
        break;
    }
  }
  broadcastState();
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
    workedCalls.add(entry.theirCall.toUpperCase());
    appendLog("info", `[qso-log] wrote ${entry.theirCall}${dialFreqHz ? "" : " (no freq set)"}`);
  } catch (error) {
    loggedQsoIds.delete(qso.id);
    appendLog("error", `[qso-log error] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- scheduler -------------------------------------------------------------

// The slot we transmit in: the active CQ row's slot, else the manual slot.
function currentTxSlot(): TxSlot {
  const cq = automation.qsos.find((qso) => qso.kind === "calling-cq" && qso.status === "active");
  return cq ? cq.nextSlot : currentSlot;
}

function currentAfOrNull(): number | null {
  if (!Number.isInteger(currentAf) || currentAf < 200 || currentAf > 3000) {
    return null;
  }
  return currentAf;
}

function clearAutomationTimer(): void {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
  scheduledAutomationTx = null;
}

// Re-arm automation on the falling edge of "active" (a transmission finished),
// or on a genuine "idle" (e.g. after cancel). The daemon rests in "pending"
// after a TX, so we never rely on seeing "idle" to resume.
function updateTxState(next: TxState): void {
  const wasActive = latestTxState === "active";
  latestTxState = next;
  if (wasActive && next !== "active") {
    activeAutomationTx = null;
  }
  if (surveyActive || next === "active") {
    return;
  }
  if (wasActive || next === "idle") {
    scheduleAutomation();
  }
}

function scheduleAutomation(): void {
  clearAutomationTimer();

  if (surveyActive || !txEnabled || latestTxState === "active") {
    broadcastState();
    return;
  }

  const af = currentAfOrNull();
  if (af === null) {
    broadcastState();
    return;
  }

  const tx = automation.nextTransmission(af);
  if (!tx) {
    broadcastState();
    return;
  }

  scheduledAutomationTx = tx;
  if (!ensureAutomationControl()) {
    broadcastState();
    return;
  }

  const seconds = secondsUntilNextSlot(tx.intent.slot);
  const delayMs = Math.max(0, (seconds - 2) * 1000);
  automationTimer = setTimeout(() => sendAutomatedTx(tx), delayMs);
  broadcastState();
}

function sendAutomatedTx(tx: AutomationTx): void {
  automationTimer = null;
  scheduledAutomationTx = null;
  if (surveyActive || !txEnabled || latestTxState === "active") {
    return;
  }
  const af = currentAfOrNull();
  if (af === null) {
    appendLog("warn", "automation paused: invalid AF");
    return;
  }
  if (!ensureAutomationControl()) {
    scheduledAutomationTx = tx;
    broadcastState();
    return;
  }
  const refreshed: AutomationTx = { ...tx, intent: { ...tx.intent, af } };
  pendingAutomationTx = refreshed;
  daemonSend({ type: "transmit", ...refreshed.intent });
  broadcastState();
}

// --- slot survey -----------------------------------------------------------

function startSurvey(): void {
  if (surveyActive) {
    return;
  }
  const slot = currentTxSlot();
  surveyActive = true;
  surveySlot = slot;

  clearAutomationTimer();
  if (pendingAutomationTx) {
    daemonSend({ type: "cancel_transmit" });
    pendingAutomationTx = null;
  }
  activeAutomationTx = null;
  scheduledAutomationTx = null;

  const delaySec = secondsUntilNextSlot(slot) + 15 + SURVEY_DECODE_LAG_SECONDS;
  surveyEndSec = Math.floor(Date.now() / 1000) + delaySec;
  appendLog("info", `[survey] holding TX ~${delaySec}s to listen on the ${slot} slot`);
  if (surveyTimer) {
    clearTimeout(surveyTimer);
  }
  surveyTimer = setTimeout(finishSurvey, delaySec * 1000);
  broadcastState();
}

function finishSurvey(): void {
  surveyTimer = null;
  const slot = surveySlot;
  surveyActive = false;
  surveySlot = null;
  if (slot) {
    const occupied = latestSlotAfs(decodes, slot);
    const suggestion = suggestClearAf(occupied, SURVEY_LO_HZ, SURVEY_HI_HZ);
    currentAf = suggestion;
    appendLog("info", `[survey] ${slot} slot updated, clear@${suggestion}Hz (${occupied.length} sigs)`);
  }
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
  appendLog("info", `[survey] aborted (${reason})`);
}

// --- operator actions ------------------------------------------------------

function ensureControl(): boolean {
  if (controlMine) {
    return true;
  }
  if (controlHeld) {
    appendLog("warn", "you do not have control (another client holds it)");
    return false;
  }
  return daemonSend({ type: "claim_control", ...(token ? { token } : {}) });
}

function ensureAutomationControl(): boolean {
  if (controlMine) {
    return true;
  }
  if (controlHeld) {
    appendLog("warn", "automation paused: another client has control");
    return false;
  }
  if (!controlClaimPending && daemonSend({ type: "claim_control", ...(token ? { token } : {}) })) {
    controlClaimPending = true;
    appendLog("info", "[control] claiming daemon control for automation");
  }
  return false;
}

function ensureIdentity(): boolean {
  if (!myCall || !myGrid) {
    appendLog("warn", "automation requires a callsign and grid");
    return false;
  }
  return true;
}

function setIdentity(call: string, grid: string): void {
  myCall = call.trim().toUpperCase();
  myGrid = grid.trim().toUpperCase();
}

function applyOptionalIdentity(message: { myCall?: string; myGrid?: string }): void {
  if (typeof message.myCall === "string" && typeof message.myGrid === "string") {
    const nextCall = message.myCall.trim().toUpperCase();
    const nextGrid = message.myGrid.trim().toUpperCase();
    if (nextCall || nextGrid) {
      myCall = nextCall;
      myGrid = nextGrid;
    }
  }
}

function findLastDecodeFrom(call: string): DecodeRecord | null {
  for (let index = decodes.length - 1; index >= 0; index--) {
    if (senderOf(decodes[index]!.message) === call) {
      return decodes[index]!;
    }
  }
  return null;
}

function callCq(slot?: TxSlot): void {
  if (!ensureIdentity()) {
    return;
  }
  if (automation.isCallingCq()) {
    stopCq("operator stopped CQ");
    return;
  }
  if (slot) {
    currentSlot = slot;
  }
  automation.createCq(myCall, myGrid, slot ?? currentSlot, "top");
  appendLog("qso", "[qso] calling CQ");
  scheduleAutomation();
}

function stopCq(reason: string): void {
  const cq = automation.qsos.find((qso) => qso.kind === "calling-cq" && qso.status === "active");
  if (!cq) {
    return;
  }

  const shouldCancelDaemonTx =
    pendingAutomationTx?.qsoId === cq.id ||
    activeAutomationTx?.qsoId === cq.id;

  automation.abandon(cq.id);
  if (scheduledAutomationTx?.qsoId === cq.id) {
    clearAutomationTimer();
  }
  if (pendingAutomationTx?.qsoId === cq.id) {
    pendingAutomationTx = null;
  }
  if (activeAutomationTx?.qsoId === cq.id) {
    activeAutomationTx = null;
  }
  if (shouldCancelDaemonTx) {
    daemonSend({ type: "cancel_transmit" });
  }
  appendLog("qso", `[qso] ${reason}`);
  scheduleAutomation();
}

function setTxSlot(slot: TxSlot): void {
  currentSlot = slot;
  const cq = automation.qsos.find((qso) => qso.kind === "calling-cq" && qso.status === "active");
  if (cq) {
    cq.nextSlot = slot;
    cq.updatedAt = new Date().toISOString();
  }
}

function replyToCall(rawCall: string): void {
  if (!ensureIdentity()) {
    return;
  }
  const call = rawCall.trim().toUpperCase();
  if (!/^[A-Z0-9/]{2,}$/.test(call)) {
    appendLog("warn", `'${call}' is not a valid callsign`);
    return;
  }
  const existing = automation.qsos.find(
    (qso) => qso.kind === "standard" && qso.theirCall === call && qso.status !== "complete"
  );
  if (existing) {
    appendLog("info", `QSO already exists for ${call}`);
    return;
  }
  const last = findLastDecodeFrom(call);
  const nextSlot = last ? oppositeSlot(slotFromTimestamp(last.ts)) : currentSlot;
  const theirGrid = last ? gridFrom(last.message) : null;
  const qso = automation.createReplyToCall(call, myCall, myGrid, nextSlot, theirGrid, "top");
  colorFor(qso.id);
  appendLog("qso", `[qso] reply to ${qso.theirCall}`);
  scheduleAutomation();
}

function qsoAction(id: string, action: string): void {
  switch (action) {
    case "complete":
      handleQsoEvents(automation.complete(id));
      break;
    case "abandon":
      automation.abandon(id);
      break;
    case "resume":
      automation.resume(id);
      break;
    case "retry":
      automation.resetAttempts(id);
      break;
    case "prevStep":
      automation.previousStep(id);
      break;
    case "nextStep":
      automation.nextStep(id);
      break;
    case "moveUp":
      automation.move(id, -1);
      break;
    case "moveDown":
      automation.move(id, 1);
      break;
    default:
      appendLog("warn", `unknown qso action '${action}'`);
      return;
  }
  scheduleAutomation();
}

function setDialFreq(mhz: number | null): void {
  if (mhz === null) {
    dialFreqHz = null;
  } else if (!Number.isFinite(mhz) || mhz <= 0) {
    appendLog("warn", "freq: enter a positive frequency in MHz (e.g. 14.074)");
    return;
  } else {
    dialFreqHz = Math.round(mhz * 1e6);
    const band = bandForMHz(mhz);
    appendLog("info", `[freq] dial = ${mhz.toFixed(3)} MHz${band ? ` (${band})` : " (out of ham band?)"}`);
  }
  void writeTuiState({ dialFreqHz }).catch((error) =>
    appendLog("error", `[state error] ${error instanceof Error ? error.message : String(error)}`)
  );
  broadcastState();
}

function haltTx(): void {
  daemonSend({ type: "cancel_transmit" });
  cancelSurvey("halted");
  pendingAutomationTx = null;
  activeAutomationTx = null;
  scheduledAutomationTx = null;
  clearAutomationTimer();
  txEnabled = false;
  automation.pauseAll("halted");
  appendLog("warn", "[tx] halted by operator");
  broadcastState();
}

function setTxEnabled(enabled: boolean): void {
  txEnabled = enabled;
  if (!enabled) {
    clearAutomationTimer();
    appendLog("info", "[tx] disabled — current transmission will finish");
  } else {
    // Resuming re-activates anything paused by a prior halt.
    for (const qso of automation.qsos) {
      if (qso.status === "paused") {
        automation.resume(qso.id);
      }
    }
    appendLog("info", "[tx] enabled");
    scheduleAutomation();
  }
  broadcastState();
}

function handleCommand(message: CommandMessage): void {
  switch (message.cmd) {
    case "setIdentity":
      setIdentity(message.call, message.grid);
      appendLog("info", `[identity] ${myCall} ${myGrid}`);
      broadcastState();
      break;
    case "setDialFreq":
      setDialFreq(message.mhz);
      break;
    case "callCq":
      applyOptionalIdentity(message);
      callCq(message.slot);
      break;
    case "replyToCall":
      applyOptionalIdentity(message);
      replyToCall(message.call);
      break;
    case "qso":
      qsoAction(message.id, message.action);
      break;
    case "setAf":
      if (Number.isInteger(message.af)) {
        currentAf = message.af;
        scheduleAutomation();
      }
      break;
    case "setSlot":
      setTxSlot(message.slot);
      scheduleAutomation();
      break;
    case "survey":
      startSurvey();
      break;
    case "txEnable":
      setTxEnabled(message.enabled);
      break;
    case "haltTx":
      haltTx();
      break;
    case "session":
      if (!ensureControl()) {
        return;
      }
      daemonSend(message.action === "start" ? { type: "start_session" } : { type: "stop_session" });
      break;
    case "releaseControl":
      if (!controlMine) {
        appendLog("warn", "control is not held by this client");
        return;
      }
      daemonSend({ type: "release_control" });
      break;
    default:
      appendLog("warn", "unknown command");
  }
}

// --- view-model / broadcast ------------------------------------------------

function buildState(): StateMessage {
  const nowMs = Date.now();

  const activeCallColors = new Map<string, string>();
  for (const qso of automation.qsos) {
    if (qso.kind === "standard" && qso.status !== "complete" && qso.theirCall) {
      activeCallColors.set(qso.theirCall, colorFor(qso.id));
    }
  }
  const ctx: AnnotateContext = { myCall, activeCallColors, workedCalls };

  const recentDecodes = decodes.slice(-200).map((record) => annotateDecode(record, ctx));
  const rosters = buildRosters(decodes, ctx, nowMs);
  const txingQsoId = pendingAutomationTx?.qsoId ?? activeAutomationTx?.qsoId ?? null;
  const displayAutomationTx = pendingAutomationTx ?? activeAutomationTx ?? scheduledAutomationTx;

  return {
    type: "state",
    serverNow: nowMs,
    cycle: { parity: cycleParity(nowMs) },
    station: {
      call: myCall,
      grid: myGrid,
      dialFreqHz,
      catConnected,
      sessionActive,
      controlHeld,
      controlMine
    },
    now: {
      ...deriveTxCard(latestTxState, displayAutomationTx),
      txEnabled,
      surveyActive,
      surveySlot,
      surveyEndSec
    },
    af: { value: currentAf, slot: currentTxSlot() },
    qsos: {
      callingCq: automation.isCallingCq(),
      active: buildActiveQsoView(automation.qsos, colorFor, txingQsoId, nowMs),
      completed: buildCompletedView(automation.qsos)
    },
    decodes: recentDecodes,
    rosters,
    occupancy: {
      even: latestSlotAfs(decodes, "even"),
      odd: latestSlotAfs(decodes, "odd")
    },
    log: logLines.slice(-200)
  };
}

const clients = new Set<WebSocket>();

function broadcastState(): void {
  if (clients.size === 0) {
    return;
  }
  const data = JSON.stringify(buildState());
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// --- static file + browser websocket server --------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestPath = (req.url ?? "/").split("?")[0]!;
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const resolved = normalize(join(publicDir, relative));
  // Path-traversal guard: never serve outside publicDir.
  if (resolved !== publicDir && !resolved.startsWith(publicDir + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(resolved);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});

const browserWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if ((req.url ?? "").split("?")[0] === "/ws") {
    browserWss.handleUpgrade(req, socket, head, (client) => browserWss.emit("connection", client, req));
  } else {
    socket.destroy();
  }
});

browserWss.on("connection", (client: WebSocket) => {
  clients.add(client);
  client.send(JSON.stringify(buildState()));
  client.on("message", (raw: RawData) => {
    try {
      const message = JSON.parse(raw.toString()) as CommandMessage;
      if (message && message.type === "command") {
        handleCommand(message);
      }
    } catch (error) {
      appendLog("error", `bad command: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  client.on("close", () => clients.delete(client));
});

// --- startup ---------------------------------------------------------------

async function loadPersistedState(): Promise<void> {
  try {
    const state = await readTuiState();
    if (state.dialFreqHz != null) {
      dialFreqHz = state.dialFreqHz;
    }
  } catch {
    // Non-fatal: start without a restored dial frequency.
  }
  try {
    for (const entry of await readQsoLog()) {
      if (entry.theirCall) {
        workedCalls.add(entry.theirCall.toUpperCase());
      }
    }
  } catch {
    // Non-fatal: start with an empty worked-call set.
  }
}

let broadcastInterval: NodeJS.Timeout | null = null;
let started = false;

function resetControllerState(): void {
  decodes.splice(0);
  automation.qsos.splice(0);
  myCall = "";
  myGrid = "";
  dialFreqHz = null;
  controlHeld = false;
  controlMine = false;
  controlClaimPending = false;
  sessionActive = false;
  catConnected = false;
  latestTxState = "idle";
  pendingAutomationTx = null;
  activeAutomationTx = null;
  scheduledAutomationTx = null;
  txEnabled = true;
  currentAf = 1000;
  currentSlot = "even";
  loggedQsoIds.clear();
  workedCalls.clear();
  surveyActive = false;
  surveySlot = null;
  surveyEndSec = 0;
  qsoColors.clear();
  nextQsoColor = 0;
  logLines.splice(0);
}

export async function startWebUiServer(options: WebUiServerOptions = {}): Promise<void> {
  if (started) {
    return;
  }
  daemonUrl = options.daemonUrl ?? daemonUrl;
  token = options.token ?? token;
  webPort = options.webPort ?? webPort;
  webHost = options.webHost ?? webHost;

  resetControllerState();
  await loadPersistedState();
  connectDaemon();

  await new Promise<void>((resolve) => {
    httpServer.listen(webPort, webHost, () => resolve());
  });
  started = true;

  // Keep the cycle clock and countdowns live in the browser.
  broadcastInterval = setInterval(broadcastState, 500);

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : webPort;
  const host = webHost;
  // eslint-disable-next-line no-console
  console.log(`digi-dx web UI on http://${host}:${port}  (daemon ${daemonUrl})`);
}

export async function closeWebUiServer(): Promise<void> {
  started = false;
  clearAutomationTimer();
  if (surveyTimer) {
    clearTimeout(surveyTimer);
    surveyTimer = null;
  }
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (daemonClient) {
    daemonClient.close();
    daemonClient = null;
  }
  for (const client of clients) {
    client.close();
  }
  clients.clear();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function webUiHttpServer(): typeof httpServer {
  return httpServer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void startWebUiServer();
}
