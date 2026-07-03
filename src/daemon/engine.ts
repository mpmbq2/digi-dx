import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import dgram, { type Socket as UdpSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import net from "node:net";
import readline from "node:readline";
import type { SessionConfig } from "./config.js";
import { listAudioDevices } from "./audio-devices.js";
import type { BroadcastEvent, DaemonStatus, DecodeEvent, TxEvent, TxIntent, TxStatus } from "./protocol.js";
import { DaemonError } from "./protocol.js";
import { TxState } from "./tx-state.js";

type EngineState = "inactive" | "starting" | "active" | "stopping";

export interface EngineSnapshot {
  state: EngineState;
  session: SessionConfig | null;
  catConnected: boolean;
  freq: number | null;
  ptt: boolean;
  tx: TxStatus;
}

export interface EngineEvents {
  status: [];
  event: [BroadcastEvent];
  error: [DaemonError];
}

export interface EngineOptions {
  ft8catPath?: string;
  ft8modemPath?: string;
  rigctldPath?: string;
  verifyAudioDevice?: boolean;
  stopTimeoutMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface EngineApi extends EventEmitter<EngineEvents> {
  snapshot(): EngineSnapshot;
  start(session: SessionConfig): Promise<void>;
  stop(): Promise<void>;
  transmit(intent: TxIntent): Promise<void>;
  cancelTransmit(): Promise<void>;
}

export class Engine extends EventEmitter<EngineEvents> implements EngineApi {
  private state: EngineState = "inactive";
  private session: SessionConfig | null = null;
  private catConnected = false;
  private freq: number | null = null;
  private ptt = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private dummyRig: ChildProcess | null = null;
  private udp: UdpSocket | null = null;
  private stoppingByRequest = false;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private txState: TxState;
  private readonly ft8catPath: string;
  private readonly ft8modemPath: string;
  private readonly rigctldPath: string;
  private readonly verifyAudioDevice: boolean;
  private readonly stopTimeoutMs: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(options: EngineOptions = {}) {
    super();
    this.ft8catPath = options.ft8catPath ?? process.env.DIGI_DX_FT8CAT_PATH ?? "ft8cat";
    this.ft8modemPath = options.ft8modemPath ?? process.env.DIGI_DX_FT8MODEM_PATH ?? "ft8modem";
    this.rigctldPath = options.rigctldPath ?? process.env.DIGI_DX_RIGCTLD_PATH ?? "rigctld";
    this.verifyAudioDevice = options.verifyAudioDevice ?? true;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.logger = options.logger ?? console;
    this.txState = this.createTxState();
  }

  snapshot(): EngineSnapshot {
    return {
      state: this.state,
      session: this.session,
      catConnected: this.catConnected,
      freq: this.freq,
      ptt: this.ptt,
      tx: this.txState.snapshot()
    };
  }

  async start(session: SessionConfig): Promise<void> {
    if (this.state !== "inactive") {
      return;
    }

    this.state = "starting";
    this.session = session;
    this.emit("status");

    try {
      await this.verifySoundDevice(session);
      await this.prepareCat(session);
      const udpPort = await this.bindUdp();
      this.spawnFt8cat(session, udpPort);
      this.state = "active";
      this.catConnected = true;
      this.emit("event", { type: "log", level: "info", message: `Session started on device ${session.device.id}` });
      this.emit("status");
    } catch (error) {
      await this.cleanupAfterStop();
      this.state = "inactive";
      this.session = null;
      this.emit("status");
      if (error instanceof DaemonError) {
        throw error;
      }
      throw new DaemonError("ENGINE_START_FAILED", "failed to start engine", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async stop(): Promise<void> {
    if (this.state === "inactive") {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }

    this.stoppingByRequest = true;
    this.state = "stopping";
    this.emit("status");
    await this.terminateChildTree(this.child);
    await this.cleanupAfterStop();
    this.state = "inactive";
    this.session = null;
    this.stoppingByRequest = false;
    this.emit("event", { type: "log", level: "info", message: "Session stopped" });
    this.emit("status");
  }

  async transmit(intent: TxIntent): Promise<void> {
    if (this.state !== "active" || !this.child) {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }
    await this.txState.transmit(intent);
    this.emit("status");
  }

  async cancelTransmit(): Promise<void> {
    if (this.state !== "active" || !this.child) {
      throw new DaemonError("NO_ACTIVE_SESSION", "no active session");
    }
    await this.txState.cancel();
    this.ptt = false;
    this.emit("status");
  }

  private createTxState(): TxState {
    const txState = new TxState({
      writeLine: (line) => {
        if (!this.child?.stdin.writable) {
          throw new Error("engine stdin is not writable");
        }
        this.child.stdin.write(`${line}\n`);
      }
    });
    txState.on("txUpdate", (event) => this.emit("event", event));
    return txState;
  }

  private async verifySoundDevice(session: SessionConfig): Promise<void> {
    if (!this.verifyAudioDevice) {
      return;
    }

    const devices = await listAudioDevices(this.ft8modemPath);
    const discovered = devices.find((device) => device.id === session.device.id);
    if (!discovered) {
      throw new DaemonError("SOUND_DEVICE_UNAVAILABLE", `sound device ${session.device.id} is unavailable`, {
        deviceId: session.device.id
      });
    }

    if (session.device.name && discovered.name !== session.device.name) {
      const message = `Saved device name '${session.device.name}' does not match discovered device '${discovered.name}'`;
      this.logger.warn(message);
      this.emit("event", { type: "log", level: "warn", message });
    }
  }

  private async prepareCat(session: SessionConfig): Promise<void> {
    if (session.cat.mode === "rigctld") {
      const ok = await canConnect("127.0.0.1", session.cat.port, 1000);
      if (!ok) {
        throw new DaemonError("CAT_FAILED", `rigctld is not accepting connections on port ${session.cat.port}`);
      }
      return;
    }

    const occupied = await canConnect("127.0.0.1", session.cat.port, 250);
    if (occupied) {
      throw new DaemonError("CAT_PORT_UNAVAILABLE", `CAT port ${session.cat.port} is already in use`);
    }

    this.dummyRig = spawn(this.rigctldPath, ["-m", "1", "-t", String(session.cat.port)], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.dummyRig.on("error", (error) => {
      this.logger.error(`dummy rigctld failed: ${error.message}`);
    });

    const ready = await waitForConnect("127.0.0.1", session.cat.port, 5000);
    if (!ready) {
      throw new DaemonError("CAT_FAILED", `dummy rigctld did not become ready on port ${session.cat.port}`);
    }
  }

  private async bindUdp(): Promise<number> {
    const socket = dgram.createSocket("udp4");
    this.udp = socket;
    socket.on("message", (message) => this.handleUdpMessage(message));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, "127.0.0.1", () => {
          socket.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      throw new DaemonError("UDP_BIND_FAILED", "failed to bind internal UDP listener", {
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const address = socket.address();
    if (typeof address === "string") {
      throw new DaemonError("UDP_BIND_FAILED", "unexpected UDP address");
    }
    return address.port;
  }

  private spawnFt8cat(session: SessionConfig, udpPort: number): void {
    const args = [
      "-A",
      `127.0.0.1:${udpPort}`,
      "-u",
      "-p",
      String(session.cat.port),
      this.ft8modemPath,
      session.mode,
      String(session.device.id)
    ];

    const child = spawn(this.ft8catPath, args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stderrRl = readline.createInterface({ input: child.stderr });
    this.stdoutRl.on("line", (line) => this.handleEngineLine(line));
    this.stderrRl.on("line", (line) => this.handleEngineDiagnostic(line));

    child.once("error", (error) => {
      this.emit("error", new DaemonError("ENGINE_START_FAILED", "failed to spawn ft8cat", { message: error.message }));
    });

    child.once("exit", () => {
      void this.handleChildExit();
    });
  }

  private handleEngineLine(line: string): void {
    const txMatch = /^TX:\s*([01])\b/.exec(line.trim());
    if (txMatch) {
      const active = txMatch[1] === "1";
      this.txState.markEngineTx(active);
      this.ptt = active;
      this.emit("status");
      return;
    }

    const faMatch = /^FA:\s*(\d+)/.exec(line.trim());
    if (faMatch) {
      this.freq = Number(faMatch[1]);
      this.emit("status");
    }
  }

  private handleEngineDiagnostic(line: string): void {
    if (line.trim()) {
      this.logger.info(line);
    }
  }

  private handleUdpMessage(message: Buffer): void {
    const parsed = parseInternalUdpLine(message.toString("utf8"));
    if (!parsed) {
      this.logger.warn(`dropping malformed ft8cat UDP line: ${message.toString("utf8").trim()}`);
      return;
    }
    this.emit("event", parsed);
  }

  private async handleChildExit(): Promise<void> {
    if (this.stoppingByRequest) {
      return;
    }

    await this.cleanupAfterStop();
    this.state = "inactive";
    this.session = null;
    const error = new DaemonError("PROCESS_CRASHED", "ft8cat exited unexpectedly");
    this.emit("error", error);
    this.emit("status");
  }

  private async cleanupAfterStop(): Promise<void> {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = null;
    this.stderrRl = null;
    this.child = null;
    this.catConnected = false;
    this.freq = null;
    this.ptt = false;
    this.txState.clear();

    if (this.udp) {
      this.udp.close();
      this.udp = null;
    }

    if (this.dummyRig) {
      await this.terminateChildTree(this.dummyRig);
      this.dummyRig = null;
    }
  }

  private async terminateChildTree(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return;
    }

    signalProcessGroup(child, "SIGTERM");
    const exited = await waitForExit(child, this.stopTimeoutMs);
    if (!exited) {
      signalProcessGroup(child, "SIGKILL");
      await waitForExit(child, 1000);
    }
  }
}

export function statusFromSnapshot(snapshot: EngineSnapshot, control: DaemonStatus["control"], id?: string | number): DaemonStatus {
  const session = snapshot.session;
  return {
    ...(id === undefined ? {} : { id }),
    type: "status",
    session: {
      active: snapshot.state !== "inactive",
      mode: session?.mode ?? null,
      device: session?.device ?? null,
      catConnected: snapshot.catConnected,
      freq: snapshot.freq,
      ptt: snapshot.ptt,
      callsign: session?.callsign ?? null,
      grid: session?.grid ?? null
    },
    tx: snapshot.tx,
    control
  };
}

export function parseInternalUdpLine(line: string): DecodeEvent | TxEvent | null {
  const trimmed = line.trim();
  const rx = /^(\d{10})\s+(-?\d+)\s+([+-]?\d+(?:\.\d+)?)\s+(\d+)\s+(?:FT[48]\s+)?[~#]\s+(.+)$/.exec(trimmed);
  if (rx) {
    return {
      type: "decode",
      ts: Number(rx[1]),
      snr: Number(rx[2]),
      dt: Number(rx[3]),
      af: Number(rx[4]),
      mode: "FT8",
      message: rx[5].trim().toUpperCase()
    };
  }

  const tx =
    /^(?:E:\s*)?(\d{10})\s+(?:E:\s*)?(\d+)\s+(FT8|FT4)\s+(.+)$/i.exec(trimmed) ??
    /^E:\s*(\d{10})?\s*(\d+)\s+(FT8|FT4)\s+(.+)$/i.exec(trimmed);
  if (tx) {
    return {
      type: "tx",
      ts: tx[1] ? Number(tx[1]) : Math.floor(Date.now() / 1000),
      af: Number(tx[2]),
      mode: tx[3].toUpperCase() as "FT8" | "FT4",
      message: tx[4].trim().toUpperCase()
    };
  }

  return null;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(host, port, 250)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
