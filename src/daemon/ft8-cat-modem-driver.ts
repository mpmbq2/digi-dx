import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import dgram, { type Socket as UdpSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import net from "node:net";
import readline from "node:readline";
import type { SessionConfig } from "./config.js";
import { listAudioDevices, type AudioDevice } from "./audio-devices.js";
import type { EngineBinaryPaths } from "./engine-binary-paths.js";
import {
  encodeTransmitLine,
  type DriverDecode,
  type DriverTx,
  type EngineDriver,
  type EngineDriverEvents
} from "./engine-driver.js";
import type { TxIntent } from "./protocol.js";
import { DaemonError } from "./protocol.js";
import { parseInternalUdpLineToDriver } from "./ft8-udp-parse.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface Ft8CatModemDriverOptions {
  paths?: Partial<EngineBinaryPaths>;
  verifyAudioDevice?: boolean;
  stopTimeoutMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  spawnFn?: SpawnFn;
  connectivity?: {
    canConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
    waitForConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  };
  bindUdpPort?: () => Promise<number>;
}

export class Ft8CatModemDriver extends EventEmitter<EngineDriverEvents> implements EngineDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private dummyRig: ChildProcess | null = null;
  private udp: UdpSocket | null = null;
  private stoppingByRequest = false;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private readonly ft8catPath: string;
  private readonly ft8modemPath: string;
  private readonly rigctldPath: string;
  private readonly verifyAudioDevice: boolean;
  private readonly stopTimeoutMs: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly spawnFn: SpawnFn;
  private readonly connectivity: {
    canConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
    waitForConnect(host: string, port: number, timeoutMs: number): Promise<boolean>;
  };
  private readonly bindUdpPort: (() => Promise<number>) | null;

  constructor(options: Ft8CatModemDriverOptions = {}) {
    super();
    this.ft8catPath = options.paths?.ft8cat ?? process.env.DIGI_DX_FT8CAT_PATH ?? "ft8cat";
    this.ft8modemPath = options.paths?.ft8modem ?? process.env.DIGI_DX_FT8MODEM_PATH ?? "ft8modem";
    this.rigctldPath = options.paths?.rigctld ?? process.env.DIGI_DX_RIGCTLD_PATH ?? "rigctld";
    this.verifyAudioDevice = options.verifyAudioDevice ?? true;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.logger = options.logger ?? console;
    this.spawnFn = options.spawnFn ?? spawn;
    this.connectivity = options.connectivity ?? { canConnect, waitForConnect };
    this.bindUdpPort = options.bindUdpPort ?? null;
  }

  async start(session: SessionConfig): Promise<void> {
    if (this.child) {
      throw new DaemonError("ENGINE_START_FAILED", "driver already running");
    }

    await this.verifySoundDevice(session);
    await this.prepareCat(session);
    const udpPort = await this.bindUdp();
    this.spawnFt8cat(session, udpPort);
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.stoppingByRequest = true;
    await this.terminateChildTree(this.child);
    await this.cleanupAfterStop();
    this.stoppingByRequest = false;
  }

  async transmit(intent: TxIntent): Promise<void> {
    if (!this.child?.stdin.writable) {
      throw new DaemonError("TX_FAILED", "engine stdin is not writable");
    }

    try {
      this.child.stdin.write(`${encodeTransmitLine(intent)}\n`);
    } catch (error) {
      throw new DaemonError("TX_FAILED", "failed to write transmit command", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async cancelTransmit(): Promise<void> {
    if (!this.child?.stdin.writable) {
      throw new DaemonError("TX_FAILED", "engine stdin is not writable");
    }

    try {
      this.child.stdin.write("STOP\n");
    } catch (error) {
      throw new DaemonError("TX_FAILED", "failed to write STOP command", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async listAudioDevices(): Promise<AudioDevice[]> {
    return listAudioDevices(this.ft8modemPath);
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
    }
  }

  private async prepareCat(session: SessionConfig): Promise<void> {
    if (session.cat.mode === "rigctld") {
      const ok = await this.connectivity.canConnect("127.0.0.1", session.cat.port, 1000);
      if (!ok) {
        throw new DaemonError("CAT_FAILED", `rigctld is not accepting connections on port ${session.cat.port}`);
      }
      return;
    }

    const occupied = await this.connectivity.canConnect("127.0.0.1", session.cat.port, 250);
    if (occupied) {
      throw new DaemonError("CAT_PORT_UNAVAILABLE", `CAT port ${session.cat.port} is already in use`);
    }

    this.dummyRig = this.spawnFn(this.rigctldPath, ["-m", "1", "-t", String(session.cat.port)], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.dummyRig.on("error", (error) => {
      this.logger.error(`dummy rigctld failed: ${error.message}`);
    });

    const ready = await this.connectivity.waitForConnect("127.0.0.1", session.cat.port, 5000);
    if (!ready) {
      throw new DaemonError("CAT_FAILED", `dummy rigctld did not become ready on port ${session.cat.port}`);
    }
  }

  private async bindUdp(): Promise<number> {
    if (this.bindUdpPort) {
      const port = await this.bindUdpPort();
      const socket = dgram.createSocket("udp4");
      this.udp = socket;
      socket.on("message", (message) => this.handleUdpMessage(message));
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(port, "127.0.0.1", () => {
          socket.off("error", reject);
          resolve();
        });
      });
      return port;
    }

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

    const child = this.spawnFn(this.ft8catPath, args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stderrRl = readline.createInterface({ input: child.stderr });
    this.stdoutRl.on("line", (line) => this.handleEngineLine(line));
    this.stderrRl.on("line", (line) => this.handleEngineDiagnostic(line));

    child.once("error", (error) => {
      this.emit("crash", new Error(`failed to spawn ft8cat: ${error.message}`));
    });

    child.once("exit", () => {
      void this.handleChildExit();
    });
  }

  private handleEngineLine(line: string): void {
    const txMatch = /^TX:\s*([01])\b/.exec(line.trim());
    if (txMatch) {
      this.emit("ptt", txMatch[1] === "1");
      return;
    }

    const faMatch = /^FA:\s*(\d+)/.exec(line.trim());
    if (faMatch) {
      this.emit("freq", Number(faMatch[1]));
    }
  }

  private handleEngineDiagnostic(line: string): void {
    if (line.trim()) {
      this.logger.info(line);
    }
  }

  private handleUdpMessage(message: Buffer): void {
    const parsed = parseInternalUdpLineToDriver(message.toString("utf8"));
    if (!parsed) {
      this.logger.warn(`dropping malformed ft8cat UDP line: ${message.toString("utf8").trim()}`);
      return;
    }

    if ("snr" in parsed) {
      this.emit("decode", parsed as DriverDecode);
      return;
    }
    this.emit("tx", parsed as DriverTx);
  }

  private async handleChildExit(): Promise<void> {
    if (this.stoppingByRequest) {
      return;
    }

    await this.cleanupAfterStop();
    this.emit("crash", new Error("ft8cat exited unexpectedly"));
  }

  private async cleanupAfterStop(): Promise<void> {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = null;
    this.stderrRl = null;
    this.child = null;

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
