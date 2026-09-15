import { EventEmitter } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import type { SessionConfig, DecodeEvent, EngineKind } from "../../core/protocol.js";
import { loadConfig, saveConfig as persistConfig, resolveConfigPath } from "../daemon/config.js";
import { type AudioDevice } from "../daemon/audio-devices.js";
import { Engine } from "../daemon/engine.js";
import { SimulatedDriver, resolveSimOptions } from "../daemon/simulated-driver.js";
import { Ft8CatModemDriver } from "../daemon/ft8-cat-modem-driver.js";
import { resolveEngineBinaryPaths } from "../daemon/engine-binary-paths.js";
import { EdgePairingService } from "./pairing.js";
import { PttWatchdog } from "./watchdog.js";
import { SlotClock } from "../../core/slot-clock.js";

// Comprehensive telemetry model representing the 5 diagnostic pillars:
// 1. Program & Watchdog Status
// 2. Configuration Setup
// 3. Server / Cloud Communication
// 4. Radio CAT Communication
// 5. FT8 Engine & Audio DSP
export interface EdgeTelemetry {
  program: {
    uptimeSeconds: number;
    version: string;
    status: "healthy" | "degraded" | "error";
    engineState: "inactive" | "starting" | "active" | "stopping";
  };
  config: {
    callsign: string;
    grid: string;
    deviceId: number;
    deviceName?: string;
    catMode: "rigctld" | "dummy";
    catPort: number;
    cloudUrl: string;
    isConfigured: boolean;
  };
  server: {
    status: "unpaired" | "pairing" | "paired" | "connected" | "disconnected";
    connected: boolean;
    stationId: string;
    activeCode: string | null;
    codeExpiresInSec: number | null;
    pingMs: number | null;
    lastHeartbeatTs: number | null;
  };
  radio: {
    catConnected: boolean;
    freqHz: number | null;
    ptt: boolean;
    lastCatCheckTs: number | null;
    catError: string | null;
  };
  ft8: {
    engineKind: EngineKind;
    sessionActive: boolean;
    slotParity: "even" | "odd";
    slotSecondsRemaining: number;
    decodesThisSlot: number;
    totalDecodes: number;
    lastDecodeMessage: string | null;
    lastDecodeTs: number | null;
  };
  watchdog: {
    armed: boolean;
    timeoutMs: number;
    hasTimedOut: boolean;
  };
}

export function formatMhz(hz: number | null): string {
  if (hz === null || !Number.isFinite(hz) || hz <= 0) {
    return "—";
  }
  return `${(hz / 1e6).toFixed(3)} MHz`;
}

export function createInitialTelemetry(stationId = "unknown"): EdgeTelemetry {
  return {
    program: { uptimeSeconds: 0, version: "0.1.0", status: "healthy", engineState: "inactive" },
    config: { callsign: "N0CALL", grid: "FN31", deviceId: 0, catMode: "rigctld", catPort: 4532, cloudUrl: "ws://127.0.0.1:8795", isConfigured: false },
    server: { status: "unpaired", connected: false, stationId, activeCode: null, codeExpiresInSec: null, pingMs: null, lastHeartbeatTs: null },
    radio: { catConnected: false, freqHz: null, ptt: false, lastCatCheckTs: null, catError: null },
    ft8: { engineKind: "ft8cat", sessionActive: false, slotParity: "even", slotSecondsRemaining: 15, decodesThisSlot: 0, totalDecodes: 0, lastDecodeMessage: null, lastDecodeTs: null },
    watchdog: { armed: false, timeoutMs: 500, hasTimedOut: false }
  };
}

export interface EdgeStationConfig extends SessionConfig {
  cloudUrl?: string;
}

export interface EdgeRuntimeOptions {
  configPath?: string;
  cloudUrl?: string;
  stationId?: string;
  forceSimulated?: boolean;
  engine?: Engine;
  pairingService?: EdgePairingService;
  watchdogTimeoutMs?: number;
  enableWatchdog?: boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface EdgeRuntimeEvents {
  telemetry: [EdgeTelemetry];
  decode: [DecodeEvent];
  catTest: [{ ok: boolean; freqHz: number | null; error?: string }];
  pttTest: [{ ok: boolean; error?: string }];
  error: [Error];
}

async function sendRigctldCommand(port: number, command: string, timeoutMs = 2000): Promise<{ ok: boolean; response: string; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const finish = (ok: boolean, res: string, error?: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, response: res.trim(), error });
    };

    socket.setTimeout(timeoutMs, () => finish(false, "", `Timeout connecting to rigctld on port ${port}`));
    socket.once("connect", () => socket.write(command.endsWith("\n") ? command : `${command}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\n")) {
        finish(true, response);
      }
    });
    socket.once("error", (err) => finish(false, "", err.message));
  });
}

export class EdgeRuntime extends EventEmitter<EdgeRuntimeEvents> {
  private readonly startedAt = Date.now();
  private readonly configPath: string;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly forceSimulated: boolean;

  private engine: Engine;
  private ownsEngine = false;
  private pairingService: EdgePairingService;
  private watchdog: PttWatchdog;
  private cloudSocket: WebSocket | null = null;
  private cloudUrl: string;
  private cloudPingMs: number | null = null;
  private lastHeartbeatTs: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private currentConfig: EdgeStationConfig | null = null;
  private isConfigured = false;
  private totalDecodes = 0;
  private decodesThisSlot = 0;
  private lastSlotStartTs = 0;
  private lastDecodeMessage: string | null = null;
  private lastDecodeTs: number | null = null;
  private lastCatCheckTs: number | null = null;
  private catError: string | null = null;
  private telemetryTicker: NodeJS.Timeout | null = null;

  constructor(options: EdgeRuntimeOptions = {}) {
    super();
    this.configPath = options.configPath ?? resolveConfigPath();
    this.logger = options.logger ?? console;
    this.forceSimulated = options.forceSimulated ?? false;
    this.cloudUrl = options.cloudUrl ?? process.env.DIGI_DX_CLOUD_URL ?? "ws://127.0.0.1:8795";

    this.pairingService =
      options.pairingService ??
      new EdgePairingService({
        stationId: options.stationId ?? process.env.DIGI_DX_STATION_ID
      });

    this.watchdog = new PttWatchdog({
      timeoutMs: options.watchdogTimeoutMs ?? 500,
      logger: this.logger,
      onTimeout: async () => {
        this.logger.warn("[edge-runtime] fail-safe watchdog triggered: aborting transmit");
        try {
          await this.engine.cancelTransmit();
        } catch {
          // best-effort
        }
        this.emitTelemetry();
      }
    });

    if (options.engine) {
      this.engine = options.engine;
    } else {
      this.ownsEngine = true;
      const defaultDriver = new SimulatedDriver(this.forceSimulated ? resolveSimOptions() : {});
      const simDriver = new SimulatedDriver(this.forceSimulated ? resolveSimOptions() : {});
      this.engine = new Engine({
        driver: defaultDriver,
        simulatedDriver: simDriver,
        logger: this.logger,
        enableWatchdog: options.enableWatchdog ?? true,
        watchdogTimeoutMs: options.watchdogTimeoutMs ?? 500
      });
    }

    this.setupEngineListeners();
    this.setupPairingListeners();
  }

  async init(): Promise<void> {
    if (this.ownsEngine && !this.forceSimulated) {
      try {
        const paths = await resolveEngineBinaryPaths();
        const liveDriver = new Ft8CatModemDriver({ paths });
        const simDriver = new SimulatedDriver({});
        this.engine = new Engine({
          driver: liveDriver,
          simulatedDriver: simDriver,
          logger: this.logger,
          enableWatchdog: true,
          watchdogTimeoutMs: 500
        });
        this.setupEngineListeners();
      } catch (err) {
        this.logger.warn(`[edge-runtime] live engine binaries unavailable (${String(err)}), using simulated driver`);
      }
    }

    await this.loadInitialConfig();

    if (this.cloudUrl) {
      this.connectCloudGateway(this.cloudUrl);
    }

    this.telemetryTicker = setInterval(() => {
      this.emitTelemetry();
    }, 1000);
  }

  getTelemetry(): EdgeTelemetry {
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const pairing = this.pairingService.state;
    const engineSnap = this.engine.snapshot();

    // Canonical FT8 slot calculations via SlotClock
    const clock = new SlotClock(engineSnap.clock);
    const currentSlot = clock.currentSlot();
    const oppositeSlot = currentSlot === "even" ? "odd" : "even";
    const slotSecondsRemaining = Math.max(0, Math.min(15, clock.secondsUntilSlot(oppositeSlot)));

    // Track slot boundaries for per-slot decodes
    const nowSec = Math.floor(Date.now() / 1000);
    const slotBoundary = Math.floor(nowSec / 15) * 15;
    if (this.lastSlotStartTs !== slotBoundary) {
      this.lastSlotStartTs = slotBoundary;
      this.decodesThisSlot = 0;
    }

    // Consolidated 3-line server link status
    const isSocketOpen = this.cloudSocket?.readyState === WebSocket.OPEN;
    const serverStatus: EdgeTelemetry["server"]["status"] = isSocketOpen
      ? (pairing.status === "pairing" ? "pairing" : "connected")
      : (pairing.status === "paired" ? "disconnected" : "unpaired");

    const codeExpiresInSec = pairing.expiresAt ? Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000)) : null;

    return {
      program: {
        uptimeSeconds,
        version: "0.1.0",
        status: !this.catError && !this.watchdog.hasTimedOut ? "healthy" : "degraded",
        engineState: engineSnap.state
      },
      config: {
        callsign: this.currentConfig?.callsign ?? "",
        grid: this.currentConfig?.grid ?? "",
        deviceId: this.currentConfig?.device.id ?? 0,
        deviceName: this.currentConfig?.device.name,
        catMode: this.currentConfig?.cat.mode ?? "rigctld",
        catPort: this.currentConfig?.cat.port ?? 4532,
        cloudUrl: this.cloudUrl,
        isConfigured: this.isConfigured
      },
      server: {
        status: serverStatus,
        connected: isSocketOpen,
        stationId: pairing.stationId,
        activeCode: pairing.activeCode,
        codeExpiresInSec,
        pingMs: this.cloudPingMs,
        lastHeartbeatTs: this.lastHeartbeatTs
      },
      radio: {
        catConnected: engineSnap.catConnected,
        freqHz: engineSnap.freq,
        ptt: engineSnap.ptt,
        lastCatCheckTs: this.lastCatCheckTs,
        catError: this.catError
      },
      ft8: {
        engineKind: engineSnap.engine,
        sessionActive: engineSnap.session !== null,
        slotParity: currentSlot,
        slotSecondsRemaining,
        decodesThisSlot: this.decodesThisSlot,
        totalDecodes: this.totalDecodes,
        lastDecodeMessage: this.lastDecodeMessage,
        lastDecodeTs: this.lastDecodeTs
      },
      watchdog: {
        armed: this.watchdog.isArmed,
        timeoutMs: this.watchdog.currentTimeoutMs,
        hasTimedOut: this.watchdog.hasTimedOut
      }
    };
  }

  async saveConfig(partial: Partial<EdgeStationConfig>): Promise<void> {
    const existing = this.currentConfig ?? {
      mode: "FT8" as const,
      device: { id: 0, name: "Default Audio" },
      callsign: "N0CALL",
      grid: "FN31",
      cat: { mode: "rigctld" as const, port: 4532 }
    };

    const updated: EdgeStationConfig = {
      mode: "FT8",
      device: partial.device ?? existing.device,
      callsign: (partial.callsign ?? existing.callsign).trim().toUpperCase(),
      grid: (partial.grid ?? existing.grid).trim().toUpperCase(),
      cat: partial.cat ?? existing.cat,
      cloudUrl: partial.cloudUrl ?? existing.cloudUrl ?? this.cloudUrl
    };

    if (updated.cloudUrl && updated.cloudUrl !== this.cloudUrl) {
      this.cloudUrl = updated.cloudUrl;
      this.connectCloudGateway(this.cloudUrl);
    }

    try {
      await persistConfig(updated, this.configPath);
      this.currentConfig = updated;
      this.isConfigured = true;
      this.emitTelemetry();

      const snap = this.engine.snapshot();
      if (snap.state === "inactive" && !snap.session) {
        await this.engine.start(updated, this.forceSimulated ? "simulated" : undefined);
      }
    } catch (err) {
      this.logger.error(`[edge-runtime] failed to save config: ${String(err)}`);
      throw err;
    }
  }

  generatePairingCode(): { code: string; expiresAt: number } {
    const result = this.pairingService.generatePairingCode();
    if (this.cloudSocket?.readyState === WebSocket.OPEN) {
      this.cloudSocket.send(
        JSON.stringify({
          type: "edge_pairing_code",
          stationId: this.pairingService.state.stationId,
          code: result.code,
          expiresAt: result.expiresAt
        })
      );
    }
    this.emitTelemetry();
    return result;
  }

  async testCat(): Promise<{ ok: boolean; freqHz: number | null; catConnected: boolean; error?: string }> {
    this.lastCatCheckTs = Date.now();
    const config = this.currentConfig;
    const catPort = config?.cat.port ?? 4532;
    const catMode = config?.cat.mode ?? "rigctld";

    if (catMode === "dummy") {
      this.catError = null;
      const res = { ok: true, freqHz: 14074000, catConnected: true };
      this.emit("catTest", res);
      this.emitTelemetry();
      return res;
    }

    // If session is already running with active CAT, reuse its reading to avoid port contention
    const snap = this.engine.snapshot();
    if (snap.session && snap.catConnected) {
      this.catError = null;
      const res = { ok: true, freqHz: snap.freq ?? 14074000, catConnected: true };
      this.emit("catTest", res);
      this.emitTelemetry();
      return res;
    }

    const probe = await sendRigctldCommand(catPort, "f\n", 2000);
    const freq = Number(probe.response.split("\n")[0]?.trim());
    const ok = probe.ok && Number.isFinite(freq) && freq > 0;
    this.catError = ok ? null : (probe.error ?? "Invalid frequency from rigctld");
    const result = { ok, freqHz: ok ? freq : null, catConnected: ok, error: this.catError ?? undefined };
    this.emit("catTest", result);
    this.emitTelemetry();
    return result;
  }

  async testPtt(durationMs = 200): Promise<{ ok: boolean; error?: string }> {
    const snap = this.engine.snapshot();
    const config = this.currentConfig;
    const catMode = config?.cat.mode ?? "rigctld";
    const catPort = config?.cat.port ?? 4532;

    this.logger.info(`[edge-runtime] safe PTT pulse test requested (${durationMs}ms)`);

    if (catMode === "dummy" || snap.engine === "simulated") {
      await new Promise((r) => setTimeout(r, durationMs));
      this.emit("pttTest", { ok: true });
      this.emitTelemetry();
      return { ok: true };
    }

    const keyOn = await sendRigctldCommand(catPort, "T 1\n", 1500);
    if (!keyOn.ok) {
      const res = { ok: false, error: keyOn.error };
      this.emit("pttTest", res);
      this.emitTelemetry();
      return res;
    }

    await new Promise((r) => setTimeout(r, durationMs));
    const keyOff = await sendRigctldCommand(catPort, "T 0\n", 1500);
    const res = { ok: keyOff.ok, error: keyOff.error };
    this.emit("pttTest", res);
    this.emitTelemetry();
    return res;
  }

  async listAudioDevices(): Promise<AudioDevice[]> {
    return this.engine.listAudioDevices(this.forceSimulated ? "simulated" : undefined);
  }

  connectCloudGateway(url: string): void {
    if (this.cloudSocket) {
      try {
        this.cloudSocket.close();
      } catch {
        // ignore
      }
      this.cloudSocket = null;
    }

    this.cloudUrl = url;
    try {
      const ws = new WebSocket(url);
      this.cloudSocket = ws;

      ws.on("open", () => {
        this.logger.info(`[edge-runtime] connected to cloud gateway at ${url}`);
        this.emitTelemetry();

        const pairing = this.pairingService.state;
        if (pairing.status === "paired" && pairing.sessionToken) {
          ws.send(JSON.stringify({ type: "register_edge", stationId: pairing.stationId, token: pairing.sessionToken }));
        } else if (pairing.activeCode) {
          ws.send(JSON.stringify({ type: "edge_pairing_code", stationId: pairing.stationId, code: pairing.activeCode, expiresAt: pairing.expiresAt }));
        }

        this.startHeartbeat();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleCloudMessage(msg);
        } catch {
          // ignore
        }
      });

      ws.on("close", () => {
        this.logger.warn("[edge-runtime] cloud gateway connection closed");
        this.stopHeartbeat();
        this.emitTelemetry();
      });

      ws.on("error", (err) => {
        this.logger.warn(`[edge-runtime] cloud gateway socket error: ${err.message}`);
      });
    } catch (err) {
      this.logger.warn(`[edge-runtime] failed to connect to cloud: ${String(err)}`);
    }
  }

  private handleCloudMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");

    if (type === "pairing_complete") {
      this.pairingService.verifyAndClaim(this.pairingService.state.activeCode ?? "", String(msg.sessionToken ?? ""));
      this.emitTelemetry();
      return;
    }

    if (type === "heartbeat_ack") {
      const sentTs = Number(msg.ts ?? 0);
      if (sentTs > 0) {
        this.cloudPingMs = Math.max(0, Date.now() - sentTs);
        this.lastHeartbeatTs = Date.now();
        this.watchdog.pet();
      }
      this.emitTelemetry();
      return;
    }

    if (type === "transmit") {
      const af = Number(msg.af);
      const slot = msg.slot === "even" || msg.slot === "odd" ? msg.slot : "even";
      const message = String(msg.message ?? "");
      this.watchdog.arm();
      void this.engine.transmit({ af, slot, message });
      return;
    }

    if (type === "cancel_transmit") {
      this.watchdog.disarm();
      void this.engine.cancelTransmit();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.cloudSocket?.readyState === WebSocket.OPEN) {
        this.cloudSocket.send(JSON.stringify({ type: "heartbeat", stationId: this.pairingService.state.stationId, ts: Date.now() }));
      }
    }, 4000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setupEngineListeners(): void {
    this.engine.on("event", (evt) => {
      if (evt.type === "decode") {
        this.totalDecodes += 1;
        this.decodesThisSlot += 1;
        this.lastDecodeMessage = evt.message;
        this.lastDecodeTs = evt.ts;
        this.emit("decode", evt);

        if (this.cloudSocket?.readyState === WebSocket.OPEN) {
          this.cloudSocket.send(JSON.stringify({ type: "decode_stream", stationId: this.pairingService.state.stationId, decode: evt }));
        }
      }
      this.emitTelemetry();
    });

    this.engine.on("status", () => this.emitTelemetry());
    this.engine.on("error", (err) => {
      this.logger.error(`[edge-runtime] engine error: ${err.message}`);
      this.emitTelemetry();
    });
  }

  private setupPairingListeners(): void {
    const refresh = () => this.emitTelemetry();
    this.pairingService.on("codeGenerated", refresh);
    this.pairingService.on("paired", refresh);
    this.pairingService.on("unpaired", refresh);
    this.pairingService.on("expired", refresh);
  }

  private async loadInitialConfig(): Promise<void> {
    try {
      const res = await loadConfig(this.configPath);
      if (res.complete && res.session) {
        this.currentConfig = { ...res.session, cloudUrl: this.cloudUrl };
        this.isConfigured = true;
        if (this.engine.snapshot().state === "inactive") {
          await this.engine.start(res.session, this.forceSimulated ? "simulated" : undefined);
        }
      }
    } catch {
      this.isConfigured = false;
    }
    this.emitTelemetry();
  }

  private emitTelemetry(): void {
    this.emit("telemetry", this.getTelemetry());
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.telemetryTicker) {
      clearInterval(this.telemetryTicker);
      this.telemetryTicker = null;
    }
    if (this.cloudSocket) {
      try {
        this.cloudSocket.close();
      } catch {
        // ignore
      }
      this.cloudSocket = null;
    }
    if (this.ownsEngine && this.engine.snapshot().state !== "inactive") {
      await this.engine.stop();
    }
    this.watchdog.disarm();
    this.pairingService.dispose();
  }
}
