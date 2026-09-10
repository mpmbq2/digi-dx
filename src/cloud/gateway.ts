import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { StationStore } from "./store.js";
import { StationSessionManager } from "./session.js";
import type { DaemonCommand, DecodeEvent, ServerMessage } from "../../core/protocol.js";

// CloudGateway — Remote backend routing edge streams, enforcing exclusivity,
// and persisting telemetry (R5, R6, R7, F1, F4).

export interface CloudGatewayOptions {
  port?: number;
  host?: string;
  store?: StationStore;
  sessionManager?: StationSessionManager;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface CloudGatewayServer {
  server: WebSocketServer;
  port: number;
  store: StationStore;
  sessionManager: StationSessionManager;
  close: () => Promise<void>;
  pairStation: (stationId: string, code: string, edgeSocket: WebSocket) => void;
}

interface ClientMeta {
  id: string;
  role: "edge" | "portal" | "unknown";
  stationId?: string;
  socket: WebSocket;
}

export function createCloudGateway(options: CloudGatewayOptions = {}): CloudGatewayServer {
  const store = options.store ?? new StationStore();
  const sessionManager = options.sessionManager ?? new StationSessionManager();
  const logger = options.logger ?? console;
  const port = options.port ?? 8795;

  const server = new WebSocketServer({
    port,
    host: options.host ?? "0.0.0.0"
  });

  const clients = new Map<WebSocket, ClientMeta>();
  // stationId -> edge WebSocket
  const edgeSockets = new Map<string, WebSocket>();
  // pending pairing: code -> { stationId, edgeSocket, expiresAt }
  const pendingPairings = new Map<string, { stationId: string; edgeSocket: WebSocket; expiresAt: number }>();

  server.on("connection", (socket) => {
    const meta: ClientMeta = {
      id: randomUUID(),
      role: "unknown",
      socket
    };
    clients.set(socket, meta);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        handleMessage(meta, msg);
      } catch (err) {
        sendJson(socket, { type: "error", code: "INVALID_JSON", message: "Malformed JSON payload" });
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      if (meta.role === "edge" && meta.stationId) {
        if (edgeSockets.get(meta.stationId) === socket) {
          edgeSockets.delete(meta.stationId);
        }
      }
      if (meta.role === "portal" && meta.stationId) {
        sessionManager.releaseControl(meta.stationId, meta.id);
      }
    });
  });

  function handleMessage(client: ClientMeta, msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");

    // 1. Edge registration / connection
    if (type === "register_edge") {
      const stationId = String(msg.stationId ?? "");
      const token = String(msg.token ?? "");
      if (!stationId) {
        sendJson(client.socket, { type: "error", code: "INVALID_STATION", message: "stationId is required" });
        return;
      }
      client.role = "edge";
      client.stationId = stationId;
      edgeSockets.set(stationId, client.socket);
      sessionManager.registerStation(stationId, token);
      sendJson(client.socket, { type: "edge_registered", stationId });
      return;
    }

    // 2. Edge pairing announcement
    if (type === "edge_pairing_code") {
      const stationId = String(msg.stationId ?? "");
      const code = String(msg.code ?? "");
      const expiresAt = Number(msg.expiresAt ?? (Date.now() + 300_000));
      client.role = "edge";
      client.stationId = stationId;
      edgeSockets.set(stationId, client.socket);
      pendingPairings.set(code, { stationId, edgeSocket: client.socket, expiresAt });
      sendJson(client.socket, { type: "pairing_code_acknowledged", code });
      return;
    }

    // 3. Portal claiming pairing with 6-digit code (F1)
    if (type === "claim_pairing") {
      const code = String(msg.code ?? "").trim();
      const pending = pendingPairings.get(code);
      if (!pending || Date.now() > pending.expiresAt) {
        sendJson(client.socket, { type: "error", code: "INVALID_PAIRING_CODE", message: "Code is invalid or expired" });
        return;
      }

      const { stationId, edgeSocket } = pending;
      pendingPairings.delete(code);
      const sessionToken = sessionManager.registerStation(stationId);

      // Notify edge of successful pairing
      sendJson(edgeSocket, { type: "pairing_complete", stationId, sessionToken });

      // Notify portal
      client.role = "portal";
      client.stationId = stationId;
      sendJson(client.socket, { type: "paired_success", stationId, sessionToken });
      return;
    }

    // 4. Portal connection & station subscription
    if (type === "connect_portal") {
      const stationId = String(msg.stationId ?? "");
      const token = String(msg.token ?? "");
      if (!sessionManager.isStationTokenValid(stationId, token)) {
        sendJson(client.socket, { type: "error", code: "AUTH_FAILED", message: "Invalid station token" });
        return;
      }
      client.role = "portal";
      client.stationId = stationId;

      // Send backlog of recent decodes
      const recentDecodes = store.getDecodes(stationId, 50);
      const recentQsos = store.getQsos(stationId);
      sendJson(client.socket, {
        type: "portal_connected",
        stationId,
        recentDecodes,
        recentQsos
      });
      return;
    }

    // 5. Portal control claim (R7 single-operator exclusivity)
    if (type === "claim_control") {
      if (client.role !== "portal" || !client.stationId) {
        sendJson(client.socket, { type: "error", code: "NOT_CONNECTED", message: "Must connect to a station first" });
        return;
      }
      const result = sessionManager.claimControl(client.stationId, client.id, String(msg.callsign ?? ""));
      if (!result.success) {
        sendJson(client.socket, { type: "error", code: "CONTROL_UNAVAILABLE", message: result.error });
        return;
      }
      sendJson(client.socket, { type: "control_granted", sessionId: result.claim?.sessionId });
      broadcastToStationPortals(client.stationId, {
        type: "control_status",
        held: true,
        controllerId: client.id
      });
      return;
    }

    // 6. Portal release control
    if (type === "release_control") {
      if (client.role === "portal" && client.stationId) {
        sessionManager.releaseControl(client.stationId, client.id);
        sendJson(client.socket, { type: "control_released" });
        broadcastToStationPortals(client.stationId, { type: "control_status", held: false });
      }
      return;
    }

    // 7. Telemetry / decodes streamed from Edge -> Cloud (R5)
    if (client.role === "edge" && client.stationId) {
      if (type === "decode") {
        const decode = msg as unknown as DecodeEvent;
        store.saveDecode(client.stationId, decode);
        broadcastToStationPortals(client.stationId, decode);
        return;
      }
      if (type === "status" || type === "tx" || type === "tx_update" || type === "log") {
        broadcastToStationPortals(client.stationId, msg);
        return;
      }
      if (type === "qso_log") {
        store.saveQso(client.stationId, msg.qso as any);
        broadcastToStationPortals(client.stationId, msg);
        return;
      }
    }

    // 8. Control commands streamed from Portal -> Edge (R6, F4)
    if (client.role === "portal" && client.stationId) {
      // Must hold control to transmit or control radio
      if (type === "transmit" || type === "cancel_transmit" || type === "heartbeat") {
        if (!sessionManager.isController(client.stationId, client.id)) {
          sendJson(client.socket, { type: "error", code: "CONTROL_REQUIRED", message: "You do not hold control" });
          return;
        }
        const edge = edgeSockets.get(client.stationId);
        if (!edge || edge.readyState !== WebSocket.OPEN) {
          sendJson(client.socket, { type: "error", code: "EDGE_OFFLINE", message: "Station edge radio is disconnected" });
          return;
        }
        sendJson(edge, msg);
        return;
      }
    }
  }

  function broadcastToStationPortals(stationId: string, message: unknown): void {
    for (const client of clients.values()) {
      if (client.role === "portal" && client.stationId === stationId && client.socket.readyState === WebSocket.OPEN) {
        sendJson(client.socket, message);
      }
    }
  }

  function sendJson(socket: WebSocket, data: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  return {
    server,
    port,
    store,
    sessionManager,
    pairStation: (stationId: string, code: string, edgeSocket: WebSocket) => {
      pendingPairings.set(code, { stationId, edgeSocket, expiresAt: Date.now() + 300_000 });
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const [socket] of clients) {
          socket.close();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
