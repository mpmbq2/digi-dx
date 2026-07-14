import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { realtimeClockSpec } from "../core/slot-clock.js";
import type { AudioDevice } from "../src/daemon/audio-devices.js";
import type { SessionConfig } from "../src/daemon/config.js";
import { Engine } from "../src/daemon/engine.js";
import type { EngineDriver, EngineDriverEvents } from "../src/daemon/engine-driver.js";
import type { EngineKind, SlotClockSpec, TxIntent } from "../src/daemon/protocol.js";
import { DEMO_CALLSIGN, SimulatedDriver } from "../src/daemon/simulated-driver.js";
import { isNonAssignableCallsign } from "../src/daemon/sim-station.js";
import { createDaemonWebSocketServer, type DaemonWebSocketServer } from "../src/daemon/websocket.js";

// Stands in for the real radio. If a demo session ever selects this, the test
// fails loudly rather than quietly keying an imaginary rig.
class RealDriverStub extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  readonly kind: EngineKind = "ft8cat";
  started = 0;

  clock(): SlotClockSpec {
    return realtimeClockSpec();
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {}
  async transmit(_intent: TxIntent): Promise<void> {}
  async cancelTransmit(): Promise<void> {}
  async listAudioDevices(): Promise<AudioDevice[]> {
    return [];
  }
}

const servers: DaemonWebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

let port = 8850;

async function harness(configJson: string | null) {
  const dir = await mkdtemp(join(tmpdir(), "digi-dx-demo-"));
  const configPath = join(dir, "config.json");
  if (configJson !== null) {
    await writeFile(configPath, configJson, "utf8");
  }

  const real = new RealDriverStub();
  const simulated = new SimulatedDriver({ scale: 100 });
  const engine = new Engine({ driver: real, simulatedDriver: simulated });

  port += 1;
  const server = createDaemonWebSocketServer({ engine, port, configPath });
  servers.push(server);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  await new Promise((resolve) => socket.once("open", resolve));

  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

  const send = (command: unknown) => socket.send(JSON.stringify(command));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

  send({ type: "claim_control" });
  await settle();

  return { engine, real, configPath, messages, send, settle };
}

function lastOf(messages: Array<Record<string, unknown>>, type: string) {
  return [...messages].reverse().find((message) => message.type === type);
}

// No config file at all -- the actual state of a brand-new user who installed
// digi-dx and has not wired a radio yet.
const NO_CONFIG = null;

describe("demo mode", () => {
  it("starts with no station config, where a real session is refused", async () => {
    const { messages, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session" });
    await settle();
    expect(lastOf(messages, "error")).toMatchObject({ code: "CONFIG_REQUIRED" });

    send({ type: "start_session", demo: true });
    await settle();

    const status = lastOf(messages, "status") as Record<string, any>;
    expect(status.engine).toBe("simulated");
    expect(status.session.active).toBe(true);
  });

  it("never writes the synthesized config to disk", async () => {
    // The P0. handleStartSession persists any session it is handed. If the demo
    // config took that path it would land as a complete, valid config -- and the
    // NEXT real session would key the operator's actual rig on a fabricated
    // callsign, a device that does not exist, and a dummy CAT block, with the
    // CONFIG_REQUIRED gate now permanently satisfied.
    const { configPath, messages, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();
    send({ type: "stop_session" });
    await settle();

    // Still no config file at all. A demo start must leave the disk untouched.
    await expect(readFile(configPath, "utf8")).rejects.toThrow();

    // And the gate still holds afterwards.
    messages.length = 0;
    send({ type: "start_session" });
    await settle();
    expect(lastOf(messages, "error")).toMatchObject({ code: "CONFIG_REQUIRED" });
  });

  it("never selects the real driver", async () => {
    const { real, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();

    expect(real.started).toBe(0);
  });

  it("runs under a callsign that cannot belong to a real licensee", async () => {
    // The demo callsign goes out in every transmitted message and into every
    // screenshot on a pull request. validateSessionConfig would happily accept a
    // real ham's call.
    const { messages, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();

    const status = lastOf(messages, "status") as Record<string, any>;
    expect(status.session.callsign).toBe(DEMO_CALLSIGN);
    expect(isNonAssignableCallsign(status.session.callsign)).toBe(true);
  });

  it("gives the client an identity to transmit with", async () => {
    // A demo session with no callsign or grid would start and then never make a
    // contact: the automation refuses to transmit without them.
    const { messages, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();

    const status = lastOf(messages, "status") as Record<string, any>;
    expect(status.session.callsign).toBeTruthy();
    expect(status.session.grid).toBeTruthy();
  });

  it("publishes the simulated engine's scaled clock", async () => {
    const { messages, send, settle } = await harness(NO_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();

    const status = lastOf(messages, "status") as Record<string, any>;
    expect(status.clock.scale).toBe(100);
  });
});

describe("driver selection is per session, not per process", () => {
  const COMPLETE_CONFIG = JSON.stringify({
    session: {
      mode: "FT8",
      device: { id: 1 },
      callsign: "N1MPM",
      grid: "FN33",
      cat: { mode: "dummy", port: 4532 }
    }
  });

  it("runs a demo session and then a real one in the same daemon", async () => {
    // A boot-time environment variable could not do this: the daemon holds one
    // driver for its lifetime, so a user who launched digi-dx normally would be
    // stuck on the real engine and the demo button would be dead on arrival.
    const { real, messages, send, settle } = await harness(COMPLETE_CONFIG);

    send({ type: "start_session", demo: true });
    await settle();
    expect((lastOf(messages, "status") as Record<string, any>).engine).toBe("simulated");
    expect(real.started).toBe(0);

    send({ type: "stop_session" });
    await settle();

    send({ type: "start_session" });
    await settle();
    expect((lastOf(messages, "status") as Record<string, any>).engine).toBe("ft8cat");
    expect(real.started).toBe(1);
  });

  it("stops routing the simulated band's decodes once the demo session ends", async () => {
    // The driver outlives the session that selected it. If its listeners were
    // left bound, a stopped demo would keep pushing decodes into a real session.
    const { engine, send, settle } = await harness(COMPLETE_CONFIG);

    const events: unknown[] = [];
    engine.on("event", (event) => events.push(event));

    send({ type: "start_session", demo: true });
    await settle();
    send({ type: "stop_session" });
    await settle();

    const afterStop = events.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.length).toBe(afterStop);
  });
});
