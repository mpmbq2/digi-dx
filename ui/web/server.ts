import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DaemonClient } from "../../core/daemon-client.js";
import type { EngineKind } from "../../core/protocol.js";
import {
  createOperatorController,
  type ControllerState,
  type OperatorController,
  type QsoLogStore,
  type StateStore
} from "../../core/controller.js";
import { appendQsoLog, qsoLogPathFor, readQsoLog } from "../qso-log.js";
import { readTuiState, writeTuiState } from "../tui-state.js";
import { bandForMHz } from "../adif.js";
import {
  annotateDecode,
  buildActiveQsoView,
  buildCompletedView,
  buildCycleView,
  buildRosters,
  deriveTxCard,
  latestSlotAfs,
  type AnnotateContext
} from "../../core/view-model.js";
import type { CommandMessage, LogLineView, StateMessage } from "./protocol.js";

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
  /**
   * Headless-start path for verification (no browser). When `demo` is set,
   * after connecting to the daemon the server claims control and starts a demo
   * session, then resolves only once the session is live and automation can run.
   */
  headless?: { demo?: boolean };
}

// --- engine + transport wiring ---------------------------------------------

// The QSO automation engine. The web server owns no orchestration of its own: it
// constructs the controller, renders its ControllerState into the browser wire
// shape, and routes browser commands to controller methods.
let controller: OperatorController | null = null;
let daemonClient: DaemonClient | null = null;

// Stable per-QSO colour used to tint decodes/roster rows. Yellow is reserved by
// the browser for "replying to me", so it is absent from this palette. This is a
// browser presentation concern, so it lives here, not in the engine.
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

// Recent activity log ring, streamed to the browser. Fed by the engine's log
// sink; the engine holds no ring of its own.
const logLines: LogLineView[] = [];
function pushLog(level: LogLineView["level"], text: string): void {
  logLines.push({ level, text });
  if (logLines.length > 200) {
    logLines.splice(0, logLines.length - 200);
  }
}

const qsoLog: QsoLogStore = {
  append: (entry, engine: EngineKind) => appendQsoLog(entry, qsoLogPathFor(engine)),
  readAll: () => readQsoLog()
};

const stateStore: StateStore = {
  read: () => readTuiState(),
  write: (patch) => writeTuiState({ dialFreqHz: patch.dialFreqHz ?? null })
};

// --- command dispatch ------------------------------------------------------

function handleCommand(message: CommandMessage): void {
  if (!controller) {
    return;
  }
  switch (message.cmd) {
    case "setIdentity":
      controller.setIdentity(message.call, message.grid);
      break;
    case "setDialFreq":
      controller.setDialFreq(message.mhz);
      break;
    case "callCq":
      controller.callCq(message.slot, { myCall: message.myCall, myGrid: message.myGrid });
      break;
    case "replyToCall":
      controller.replyToCall(message.call, { myCall: message.myCall, myGrid: message.myGrid });
      break;
    case "qso":
      controller.qsoAction(message.id, message.action);
      break;
    case "setAf":
      controller.setAf(message.af);
      break;
    case "setSlot":
      controller.setSlot(message.slot);
      break;
    case "survey":
      controller.survey();
      break;
    case "txEnable":
      controller.setTxEnabled(message.enabled);
      break;
    case "haltTx":
      controller.haltTx();
      break;
    case "session":
      if (message.action === "start") {
        controller.startSession();
      } else {
        controller.stopSession();
      }
      break;
    case "startDemo":
      controller.startDemo();
      break;
    case "saveSetup":
      controller.saveSetup({
        deviceId: message.deviceId,
        callsign: message.callsign,
        grid: message.grid,
        catMode: message.catMode,
        catPort: message.catPort
      });
      break;
    case "releaseControl":
      controller.releaseControl();
      break;
    default:
      pushLog("warn", "unknown command");
  }
}

// --- view-model / broadcast ------------------------------------------------

function buildState(state: ControllerState): StateMessage {
  // Two clocks, deliberately. `wallNowMs` is what the browser corrects its own
  // clock against (it runs on a different machine). `nowMs` is virtual time --
  // the base decode timestamps live in -- and everything slot-shaped uses it.
  // Mixing them is how a scaled countdown ends up disagreeing with the band.
  const wallNowMs = Date.now();
  const nowMs = state.clock ? state.clock.now() : wallNowMs;

  const activeCallColors = new Map<string, string>();
  for (const qso of state.qsos.active) {
    if (qso.kind === "standard" && qso.theirCall) {
      activeCallColors.set(qso.theirCall, colorFor(qso.id));
    }
  }
  const ctx: AnnotateContext = {
    myCall: state.station.call,
    activeCallColors,
    workedCalls: state.workedCalls
  };

  const recentDecodes = state.decodes.slice(-200).map((record) => annotateDecode(record, ctx));
  const rosters = buildRosters(state.decodes, ctx, nowMs);

  return {
    type: "state",
    serverNow: wallNowMs,
    cycle: buildCycleView(state.clock, wallNowMs, nowMs),
    station: state.station,
    setup: state.setup,
    now: {
      ...deriveTxCard(state.tx.state, state.tx.displayTx),
      txEnabled: state.tx.enabled,
      surveyActive: state.survey.active,
      surveySlot: state.survey.slot,
      surveyEndSec: state.survey.endSec
    },
    af: state.af,
    qsos: {
      callingCq: state.qsos.callingCq,
      active: buildActiveQsoView(state.qsos.active, colorFor, state.tx.txingQsoId, nowMs),
      completed: buildCompletedView(state.qsos.completed)
    },
    decodes: recentDecodes,
    rosters,
    occupancy: {
      even: latestSlotAfs(state.decodes, "even"),
      odd: latestSlotAfs(state.decodes, "odd")
    },
    log: logLines.slice(-200)
  };
}

const clients = new Set<WebSocket>();

function broadcastState(): void {
  if (clients.size === 0 || !controller) {
    return;
  }
  const data = JSON.stringify(buildState(controller.state));
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
  if (controller) {
    client.send(JSON.stringify(buildState(controller.state)));
  }
  client.on("message", (raw: RawData) => {
    try {
      const message = JSON.parse(raw.toString()) as CommandMessage;
      if (message && message.type === "command") {
        handleCommand(message);
      }
    } catch (error) {
      pushLog("error", `bad command: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  client.on("close", () => clients.delete(client));
});

// --- startup ---------------------------------------------------------------

let broadcastInterval: NodeJS.Timeout | null = null;
let started = false;

async function waitUntil(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`headless: timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Claim control and start a demo session with no browser messages. The smoke
 * harness uses this so it drives the same engine path as the UI.
 */
async function bootstrapHeadlessDemo(): Promise<void> {
  await waitUntil(() => daemonClient?.connected === true, "daemon connection", 15_000);
  pushLog("info", "[demo] headless: starting on the simulated engine — nothing is transmitted");
  controller?.startDemo();
  await waitUntil(() => {
    const s = controller?.state;
    return Boolean(s?.station.sessionActive && s.station.call && s.station.grid && s.clock);
  }, "demo session", 15_000);
}

export async function startWebUiServer(options: WebUiServerOptions = {}): Promise<void> {
  if (started) {
    return;
  }
  daemonUrl = options.daemonUrl ?? daemonUrl;
  token = options.token ?? token;
  webPort = options.webPort ?? webPort;
  webHost = options.webHost ?? webHost;

  // Fresh view state on each start.
  logLines.splice(0);
  qsoColors.clear();
  nextQsoColor = 0;

  daemonClient = new DaemonClient({
    url: daemonUrl,
    token,
    reconnectMs: 2000,
    logger: (message) => {
      pushLog("error", message);
      broadcastState();
    }
  });
  controller = createOperatorController({
    client: daemonClient,
    log: qsoLog,
    state: stateStore,
    token,
    onLog: pushLog,
    bandForMHz
  });
  controller.onChange(() => broadcastState());
  controller.start();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.listen(webPort, webHost, onListening);
  });
  started = true;

  // Keep the cycle clock and countdowns live in the browser.
  broadcastInterval = setInterval(broadcastState, 500);

  if (options.headless?.demo) {
    await bootstrapHeadlessDemo();
  }

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : webPort;
  const host = webHost;
  // eslint-disable-next-line no-console
  console.log(`digi-dx web UI on http://${host}:${port}  (daemon ${daemonUrl})`);
}

export async function closeWebUiServer(): Promise<void> {
  started = false;
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (controller) {
    controller.dispose();
    controller = null;
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
    // Force-drop keep-alives so headless smoke can exit without waiting on idle sockets.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
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
