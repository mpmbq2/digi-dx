import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { SessionConfig } from "../src/daemon/config.js";
import type { EngineApi, EngineEvents, EngineSnapshot } from "../src/daemon/engine.js";
import { createDaemonWebSocketServer, type DaemonWebSocketServer } from "../src/daemon/websocket.js";
import type { TxIntent } from "../src/daemon/protocol.js";

class FakeEngine extends EventEmitter<EngineEvents> implements EngineApi {
  private snap: EngineSnapshot = {
    state: "inactive",
    session: null,
    catConnected: false,
    freq: null,
    ptt: false,
    tx: { state: "idle", af: null, slot: null, message: null }
  };
  transmitted: TxIntent[] = [];

  snapshot(): EngineSnapshot {
    return this.snap;
  }

  async start(session: SessionConfig): Promise<void> {
    this.snap = {
      ...this.snap,
      state: "active",
      session,
      catConnected: true
    };
    this.emit("status");
  }

  async stop(): Promise<void> {
    this.snap = {
      state: "inactive",
      session: null,
      catConnected: false,
      freq: null,
      ptt: false,
      tx: { state: "idle", af: null, slot: null, message: null }
    };
    this.emit("status");
  }

  async transmit(intent: TxIntent): Promise<void> {
    this.transmitted.push(intent);
    this.snap = {
      ...this.snap,
      tx: { state: "pending", af: intent.af, slot: intent.slot, message: intent.message }
    };
    this.emit("status");
  }

  async cancelTransmit(): Promise<void> {
    this.snap = {
      ...this.snap,
      tx: { state: "idle", af: null, slot: null, message: null }
    };
    this.emit("status");
  }
}

const servers: DaemonWebSocketServer[] = [];
const sockets: TestClient[] = [];

afterEach(async () => {
  for (const client of sockets.splice(0)) {
    client.socket.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("websocket control API", () => {
  it("enforces auth, control ownership, id echoing, and command normalization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-ws-"));
    const engine = new FakeEngine();
    const daemon = await startServer(engine, {
      authToken: "secret",
      configPath: join(dir, "config.json")
    });
    const ws1 = await connect(daemon.url);
    const ws2 = await connect(daemon.url);

    expect(await nextOfType(ws1, "status")).toMatchObject({ type: "status", control: { held: false } });
    expect(await nextOfType(ws2, "status")).toMatchObject({ type: "status", control: { held: false } });

    ws1.socket.send(JSON.stringify({ id: "bad", type: "claim_control", token: "wrong" }));
    expect(await nextOfType(ws1, "error")).toMatchObject({
      id: "bad",
      code: "AUTH_FAILED"
    });

    ws1.socket.send(JSON.stringify({ id: "claim", type: "claim_control", token: "secret" }));
    expect(await nextStatusWithId(ws1, "claim")).toMatchObject({
      id: "claim",
      control: { held: true, byThisClient: true }
    });
    expect(await nextOfType(ws2, "status")).toMatchObject({
      control: { held: true, byThisClient: false }
    });

    ws2.socket.send(JSON.stringify({ id: "tx2", type: "transmit", af: 2262, slot: "even", message: "cq n1mpm fn33" }));
    expect(await nextOfType(ws2, "error")).toMatchObject({
      id: "tx2",
      code: "CONTROL_REQUIRED"
    });

    ws2.socket.send(JSON.stringify({ id: "claim2", type: "claim_control", token: "secret" }));
    expect(await nextOfType(ws2, "error")).toMatchObject({
      id: "claim2",
      code: "CONTROL_UNAVAILABLE"
    });

    ws1.socket.send(JSON.stringify({ id: "start", type: "start_session", session: completeSession }));
    expect(await nextStatusWithId(ws1, "start")).toMatchObject({
      id: "start",
      session: { active: true, callsign: "N1MPM", grid: "FN33" }
    });

    ws1.socket.send(JSON.stringify({ id: "tx1", type: "transmit", af: 2262, slot: "even", message: "ja2kvb n1mpm r-15" }));
    expect(await nextStatusWithId(ws1, "tx1")).toMatchObject({
      id: "tx1",
      tx: { state: "pending", af: 2262, slot: "even", message: "JA2KVB N1MPM R-15" }
    });
    expect(engine.transmitted).toEqual([{ af: 2262, slot: "even", message: "JA2KVB N1MPM R-15" }]);
  });

  it("allows read-only audio discovery without control", async () => {
    const engine = new FakeEngine();
    const daemon = await startServer(engine, {
      listAudioDevices: async () => [
        {
          id: 141,
          name: "USB Audio CODEC (USB Audio)",
          inputs: 2,
          outputs: 2,
          defaultSampleRate: 48000
        }
      ]
    });
    const ws = await connect(daemon.url);
    await nextOfType(ws, "status");

    ws.socket.send(JSON.stringify({ id: "audio", type: "list_audio_devices" }));
    expect(await nextOfType(ws, "audio_devices")).toEqual({
      id: "audio",
      type: "audio_devices",
      devices: [
        {
          id: 141,
          name: "USB Audio CODEC (USB Audio)",
          inputs: 2,
          outputs: 2,
          defaultSampleRate: 48000
        }
      ]
    });
  });
});

const completeSession = {
  mode: "FT8",
  device: { id: 141, name: "USB Audio CODEC (USB Audio)" },
  callsign: "n1mpm",
  grid: "fn33",
  cat: { mode: "dummy", port: 4532 }
};

async function startServer(
  engine: FakeEngine,
  extra: Partial<Parameters<typeof createDaemonWebSocketServer>[0]> = {}
): Promise<{ server: DaemonWebSocketServer; url: string }> {
  const server = createDaemonWebSocketServer({
    engine,
    port: 0,
    host: "127.0.0.1",
    logger: silentLogger,
    ...extra
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.server.on("listening", () => resolve()));
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("unexpected WebSocket server address");
  }
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`
  };
}

interface TestClient {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  waiters: Array<() => void>;
}

function connect(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const client: TestClient = {
      socket,
      messages: [],
      waiters: []
    };
    sockets.push(client);
    socket.on("message", (data) => {
      client.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      const waiters = client.waiters.splice(0);
      for (const waiter of waiters) {
        waiter();
      }
    });
    socket.once("open", () => resolve(client));
    socket.once("error", reject);
  });
}

async function nextOfType(client: TestClient, type: string): Promise<Record<string, unknown>> {
  while (true) {
    const index = client.messages.findIndex((message) => message.type === type);
    if (index !== -1) {
      return client.messages.splice(index, 1)[0]!;
    }
    await new Promise<void>((resolve) => client.waiters.push(resolve));
  }
}

async function nextStatusWithId(client: TestClient, id: string): Promise<Record<string, unknown>> {
  while (true) {
    const message = await nextOfType(client, "status");
    if (message.id === id) {
      return message;
    }
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};
