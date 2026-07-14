import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeWebUiServer, startWebUiServer, webUiHttpServer } from "../ui/web/server.js";
import { FT8_SLOT_MS, realtimeClockSpec } from "../core/slot-clock.js";

const daemonServers: WebSocketServer[] = [];
const browserSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of browserSockets.splice(0)) {
    socket.close();
  }
  await closeWebUiServer();
  for (const server of daemonServers.splice(0)) {
    await closeServer(server);
  }
});

describe("web UI server", () => {
  it("streams daemon state to browsers and forwards operator commands", async () => {
    const mockDaemon = await startMockDaemon();
    await startWebUiServer({
      daemonUrl: mockDaemon.url,
      webPort: 0,
      webHost: "127.0.0.1"
    });

    const browser = await connectBrowser(webUrl());
    const statusState = await nextBrowserState(browser, (message) => message.station.call === "N1MPM");
    expect(statusState.station).toMatchObject({
      call: "N1MPM",
      grid: "FN33",
      sessionActive: true,
      catConnected: true
    });

    mockDaemon.send({
      type: "decode",
      ts: 1_800_000_015,
      snr: -7,
      dt: 0.1,
      af: 750,
      mode: "FT8",
      message: "N1MPM JA2KVB FN31"
    });

    const qsoState = await nextBrowserState(browser, (message) => message.qsos.active[0]?.call === "JA2KVB");
    expect(qsoState.decodes.at(-1)).toMatchObject({
      from: "JA2KVB",
      grid: "FN31",
      kind: "reply"
    });
    expect(qsoState.qsos.active[0]).toMatchObject({
      call: "JA2KVB",
      stepKey: "report",
      nextTx: "JA2KVB N1MPM -07"
    });

    browser.socket.send(JSON.stringify({ type: "command", cmd: "haltTx" }));
    await mockDaemon.nextCommand((message) => message.type === "cancel_transmit");
  });

  it("lets the operator change the CQ transmit slot before and during CQ", async () => {
    const mockDaemon = await startMockDaemon();
    await startWebUiServer({
      daemonUrl: mockDaemon.url,
      webPort: 0,
      webHost: "127.0.0.1"
    });

    const browser = await connectBrowser(webUrl());
    await nextBrowserState(browser, (message) => message.station.call === "N1MPM");

    browser.socket.send(JSON.stringify({ type: "command", cmd: "setSlot", slot: "odd" }));
    await nextBrowserState(browser, (message) => message.af.slot === "odd");

    browser.socket.send(JSON.stringify({ type: "command", cmd: "callCq", slot: "odd" }));
    await mockDaemon.nextCommand((message) => message.type === "claim_control");
    await nextBrowserState(
      browser,
      (message) =>
        message.qsos.callingCq === true &&
        message.af.slot === "odd" &&
        message.now.message === "CQ N1MPM FN33" &&
        message.now.slot === "odd"
    );

    browser.socket.send(JSON.stringify({ type: "command", cmd: "setSlot", slot: "even" }));
    await nextBrowserState(
      browser,
      (message) =>
        message.qsos.callingCq === true &&
        message.af.slot === "even" &&
        message.now.message === "CQ N1MPM FN33" &&
        message.now.slot === "even"
    );

    browser.socket.send(JSON.stringify({ type: "command", cmd: "callCq", slot: "even" }));
    await nextBrowserState(
      browser,
      (message) => message.qsos.callingCq === false && message.now.message == null
    );
  });
});

interface BrowserClient {
  socket: WebSocket;
  messages: Array<Record<string, any>>;
  waiters: Array<() => void>;
}

interface MockDaemon {
  url: string;
  send: (message: Record<string, unknown>) => void;
  nextCommand: (predicate: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

async function startMockDaemon(): Promise<MockDaemon> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  daemonServers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unexpected mock daemon address");
  }

  let daemonClient: WebSocket | null = null;
  const commands: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];

  server.on("connection", (socket) => {
    daemonClient = socket;
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as Record<string, unknown>;
      commands.push(command);
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
      if (command.type === "claim_control") {
        sendStatus(socket, { held: true, byThisClient: true });
      }
    });
    sendStatus(socket, { held: false, byThisClient: false });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    send(message) {
      daemonClient?.send(JSON.stringify(message));
    },
    async nextCommand(predicate) {
      while (true) {
        const index = commands.findIndex(predicate);
        if (index !== -1) {
          return commands.splice(index, 1)[0]!;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    }
  };
}

function sendStatus(
  socket: WebSocket,
  control: { held: boolean; byThisClient: boolean },
  clock = realtimeClockSpec()
): void {
  socket.send(
    JSON.stringify({
      type: "status",
      engine: "ft8cat",
      clock,
      session: {
        active: true,
        mode: "FT8",
        device: null,
        catConnected: true,
        freq: null,
        ptt: false,
        callsign: "N1MPM",
        grid: "FN33"
      },
      tx: { state: "idle", af: null, slot: null, message: null },
      control
    })
  );
}

function connectBrowser(url: string): Promise<BrowserClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}/ws`);
    const client: BrowserClient = { socket, messages: [], waiters: [] };
    browserSockets.push(socket);
    socket.on("message", (raw) => {
      client.messages.push(JSON.parse(raw.toString()) as Record<string, any>);
      for (const waiter of client.waiters.splice(0)) {
        waiter();
      }
    });
    socket.once("open", () => resolve(client));
    socket.once("error", reject);
  });
}

async function nextBrowserState(
  client: BrowserClient,
  predicate: (message: Record<string, any>) => boolean
): Promise<Record<string, any>> {
  while (true) {
    const index = client.messages.findIndex((message) => message.type === "state" && predicate(message));
    if (index !== -1) {
      return client.messages.splice(index, 1)[0]!;
    }
    await new Promise<void>((resolve) => client.waiters.push(resolve));
  }
}

function webUrl(): string {
  const address = webUiHttpServer().address();
  if (!address || typeof address === "string") {
    throw new Error("unexpected web UI address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
