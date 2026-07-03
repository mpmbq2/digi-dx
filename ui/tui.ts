import blessed from "blessed";
import { WebSocket } from "ws";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8787";
const token = process.env.DIGI_DX_AUTH_TOKEN;

interface DecodeRecord {
  ts: number;
  snr: number;
  dt: number;
  af: number;
  message: string;
}

const decodes: DecodeRecord[] = [];
let myCall = "";
let myGrid = "";
let idCounter = 1;

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
  width: "60%",
  height: "70%",
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

const composePanel = blessed.box({
  top: 3,
  left: "60%",
  width: "40%",
  height: "70%",
  border: { type: "line" },
  label: " compose "
});

const afLabel = blessed.text({ parent: composePanel, top: 0, left: 1, content: "AF (Hz):" });
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
let currentSlot: "even" | "odd" = "even";
slotButton.on("press", () => {
  currentSlot = currentSlot === "even" ? "odd" : "even";
  slotButton.setContent(`slot: ${currentSlot} (click to toggle)`);
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
  content: "CQ"
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
  content: "RR73"
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
});

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
  screen.render();
});

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
      statusBar.setContent(
        `{bold}active{/bold}=${session.active} device=${(session.device as { id?: number } | null)?.id ?? "-"} ` +
          `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} call=${session.callsign ?? "-"} grid=${session.grid ?? "-"}  ||  ` +
          `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"}  ||  control held=${control.held} mine=${control.byThisClient}`
      );
      screen.render();
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
      break;
    }
    case "tx":
      appendLog(`[tx] af=${msg.af} ${msg.message}`);
      break;
    case "tx_update":
      appendLog(`[tx_update] state=${msg.state} af=${msg.af ?? "-"} slot=${msg.slot ?? "-"} msg=${msg.message ?? "-"}`);
      break;
    case "log":
      appendLog(`[${msg.level}] ${msg.message}`);
      break;
    case "error":
      appendLog(`[error] ${msg.code}: ${msg.message}${msg.details ? ` ${JSON.stringify(msg.details)}` : ""}`);
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
