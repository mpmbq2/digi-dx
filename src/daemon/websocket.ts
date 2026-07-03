import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, saveConfig, validateSessionConfig, type SessionConfig } from "./config.js";
import { listAudioDevices, type AudioDevice } from "./audio-devices.js";
import { type EngineApi, statusFromSnapshot } from "./engine.js";
import {
  DaemonError,
  getCommandId,
  normalizeTransmit,
  parseJsonCommand,
  protocolError,
  sendJson,
  type CommandId,
  type DaemonStatus
} from "./protocol.js";

export interface DaemonWebSocketOptions {
  engine: EngineApi;
  port?: number;
  host?: string;
  authToken?: string;
  configPath?: string;
  listAudioDevices?: () => Promise<AudioDevice[]>;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface DaemonWebSocketServer {
  server: WebSocketServer;
  close: () => Promise<void>;
}

export function createDaemonWebSocketServer(options: DaemonWebSocketOptions): DaemonWebSocketServer {
  const server = new WebSocketServer({
    port: options.port ?? 8787,
    host: options.host ?? "0.0.0.0"
  });
  const clients = new Set<WebSocket>();
  const logger = options.logger ?? console;
  const discoverAudio = options.listAudioDevices ?? listAudioDevices;
  let controller: WebSocket | null = null;
  let warnedNoToken = false;

  const controlFor = (client: WebSocket): DaemonStatus["control"] => ({
    held: controller !== null,
    byThisClient: controller === client
  });

  const sendStatus = (client: WebSocket, id?: CommandId): void => {
    send(client, statusFromSnapshot(options.engine.snapshot(), controlFor(client), id));
  };

  const broadcastStatus = (requestingClient?: WebSocket, id?: CommandId): void => {
    for (const client of clients) {
      sendStatus(client, client === requestingClient ? id : undefined);
    }
  };

  server.on("connection", (client) => {
    clients.add(client);
    sendStatus(client);

    client.on("message", (raw) => {
      void handleMessage(client, raw.toString());
    });

    client.on("close", () => {
      clients.delete(client);
      if (controller === client) {
        controller = null;
        broadcastStatus();
      }
    });
  });

  options.engine.on("status", () => broadcastStatus());
  options.engine.on("event", (event) => broadcast(event));
  options.engine.on("error", (error) => {
    broadcast({
      type: "error",
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    });
    broadcastStatus();
  });

  async function handleMessage(client: WebSocket, raw: string): Promise<void> {
    let command: Record<string, unknown>;
    let id: CommandId | undefined;
    try {
      command = parseJsonCommand(raw);
      id = getCommandId(command);
      const type = command.type;

      if (typeof type !== "string") {
        throw new DaemonError("INVALID_COMMAND", "command.type is required");
      }

      switch (type) {
        case "claim_control":
          claimControl(client, command, id);
          return;
        case "release_control":
          requireControl(client);
          controller = null;
          broadcastStatus(client, id);
          return;
        case "get_status":
          sendStatus(client, id);
          return;
        case "get_config":
          await handleGetConfig(client, id);
          return;
        case "list_audio_devices":
          await handleListAudioDevices(client, id);
          return;
        case "save_config":
          requireControl(client);
          await handleSaveConfig(client, command, id);
          return;
        case "start_session":
          requireControl(client);
          await handleStartSession(client, command, id);
          return;
        case "stop_session":
          requireControl(client);
          await options.engine.stop();
          broadcastStatus(client, id);
          return;
        case "transmit":
          requireControl(client);
          await options.engine.transmit(normalizeTransmit(command));
          broadcastStatus(client, id);
          return;
        case "cancel_transmit":
          requireControl(client);
          await options.engine.cancelTransmit();
          broadcastStatus(client, id);
          return;
        default:
          throw new DaemonError("INVALID_COMMAND", `unknown command type '${type}'`);
      }
    } catch (error) {
      send(client, protocolError(id, error));
    }
  }

  function claimControl(client: WebSocket, command: Record<string, unknown>, id?: CommandId): void {
    if (options.authToken && command.token !== options.authToken) {
      throw new DaemonError("AUTH_FAILED", "control token is absent or incorrect");
    }

    if (!options.authToken && !warnedNoToken) {
      warnedNoToken = true;
      logger.warn("DIGI_DX_AUTH_TOKEN is not configured; allowing unauthenticated control claims");
    }

    if (controller && controller !== client) {
      throw new DaemonError("CONTROL_UNAVAILABLE", "another client already holds control");
    }

    controller = client;
    broadcastStatus(client, id);
  }

  function requireControl(client: WebSocket): void {
    if (controller !== client) {
      throw new DaemonError("CONTROL_REQUIRED", "control is required for this command");
    }
  }

  async function handleGetConfig(client: WebSocket, id?: CommandId): Promise<void> {
    const result = await loadConfig(options.configPath);
    send(client, {
      ...(id === undefined ? {} : { id }),
      type: "config",
      session: result.complete ? result.session : null,
      complete: result.complete,
      ...(result.complete ? {} : { missing: result.missing }),
      ...(result.invalid && result.error ? { invalid: true, error: result.error } : {})
    });
  }

  async function handleSaveConfig(client: WebSocket, command: Record<string, unknown>, id?: CommandId): Promise<void> {
    if (options.engine.snapshot().state !== "inactive") {
      throw new DaemonError("SESSION_ALREADY_ACTIVE", "config cannot be saved while a session is active");
    }

    const session = await saveConfig(command.session, options.configPath);
    send(client, {
      ...(id === undefined ? {} : { id }),
      type: "config",
      session,
      complete: true
    });
  }

  async function handleStartSession(client: WebSocket, command: Record<string, unknown>, id?: CommandId): Promise<void> {
    const active = options.engine.snapshot().state !== "inactive";
    if (active && command.session !== undefined) {
      throw new DaemonError("SESSION_ALREADY_ACTIVE", "cannot replace session config while a session is active");
    }
    if (active) {
      broadcastStatus(client, id);
      return;
    }

    let session: SessionConfig;
    if (command.session !== undefined) {
      session = validateSessionConfig(command.session);
      await saveConfig(session, options.configPath);
    } else {
      const loaded = await loadConfig(options.configPath);
      if (!loaded.complete || !loaded.session) {
        throw new DaemonError(loaded.invalid ? "CONFIG_INVALID" : "CONFIG_REQUIRED", loaded.error ?? "complete config is required", {
          missing: loaded.missing
        });
      }
      session = loaded.session;
    }

    await options.engine.start(session);
    broadcastStatus(client, id);
  }

  async function handleListAudioDevices(client: WebSocket, id?: CommandId): Promise<void> {
    const devices = await discoverAudio();
    send(client, {
      ...(id === undefined ? {} : { id }),
      type: "audio_devices",
      devices
    });
  }

  function broadcast(payload: unknown): void {
    for (const client of clients) {
      send(client, payload);
    }
  }

  function send(client: WebSocket, payload: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      sendJson((data) => client.send(data), payload);
    }
  }

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of clients) {
          client.close();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
