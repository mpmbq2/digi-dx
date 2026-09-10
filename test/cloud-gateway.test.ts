import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createCloudGateway } from "../src/cloud/gateway.js";
import { StationStore } from "../src/cloud/store.js";
import { StationSessionManager } from "../src/cloud/session.js";
import type { DecodeEvent } from "../core/protocol.js";

function nextMessageOfType(ws: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer | string) => {
      const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (parsed.type === expectedType) {
        ws.off("message", onMsg);
        resolve(parsed);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("Cloud Gateway & Telemetry Store (U4, R5, R6, R7, F1, F4)", () => {
  it("orchestrates pairing flow using 6-digit code between edge and portal (F1)", async () => {
    const gateway = createCloudGateway({ port: 8901 });

    try {
      const edgeSocket = new WebSocket("ws://127.0.0.1:8901");
      const portalSocket = new WebSocket("ws://127.0.0.1:8901");
      await Promise.all([
        new Promise((resolve) => edgeSocket.on("open", resolve)),
        new Promise((resolve) => portalSocket.on("open", resolve))
      ]);

      // Edge announces pairing code
      edgeSocket.send(JSON.stringify({
        type: "edge_pairing_code",
        stationId: "station-alpha",
        code: "789123",
        expiresAt: Date.now() + 60000
      }));

      const edgeAck = await nextMessageOfType(edgeSocket, "pairing_code_acknowledged");
      expect(edgeAck.code).toBe("789123");

      // Portal attempts to claim pairing with wrong code
      portalSocket.send(JSON.stringify({
        type: "claim_pairing",
        code: "000000"
      }));
      const badRes = await nextMessageOfType(portalSocket, "error");
      expect(badRes.code).toBe("INVALID_PAIRING_CODE");

      // Portal claims pairing with correct code
      portalSocket.send(JSON.stringify({
        type: "claim_pairing",
        code: "789123"
      }));

      const [portalSuccess, edgeComplete] = await Promise.all([
        nextMessageOfType(portalSocket, "paired_success"),
        nextMessageOfType(edgeSocket, "pairing_complete")
      ]);

      expect(portalSuccess.stationId).toBe("station-alpha");
      expect(typeof portalSuccess.sessionToken).toBe("string");

      expect(edgeComplete.stationId).toBe("station-alpha");
      expect(edgeComplete.sessionToken).toBe(portalSuccess.sessionToken);

      edgeSocket.close();
      portalSocket.close();
    } finally {
      await gateway.close();
    }
  });

  it("enforces single-operator exclusivity per station (R7)", async () => {
    const gateway = createCloudGateway({ port: 8902 });

    try {
      const edge = new WebSocket("ws://127.0.0.1:8902");
      const op1 = new WebSocket("ws://127.0.0.1:8902");
      const op2 = new WebSocket("ws://127.0.0.1:8902");

      await Promise.all([
        new Promise((resolve) => edge.on("open", resolve)),
        new Promise((resolve) => op1.on("open", resolve)),
        new Promise((resolve) => op2.on("open", resolve))
      ]);

      // Register edge
      edge.send(JSON.stringify({ type: "register_edge", stationId: "station-beta", token: "tok-123" }));
      await nextMessageOfType(edge, "edge_registered");

      // Connect Operator 1
      op1.send(JSON.stringify({ type: "connect_portal", stationId: "station-beta", token: "tok-123" }));
      await nextMessageOfType(op1, "portal_connected");

      // Connect Operator 2
      op2.send(JSON.stringify({ type: "connect_portal", stationId: "station-beta", token: "tok-123" }));
      await nextMessageOfType(op2, "portal_connected");

      // Operator 1 claims control
      op1.send(JSON.stringify({ type: "claim_control", callsign: "K1ABC" }));
      const claim1 = await nextMessageOfType(op1, "control_granted");
      expect(claim1.sessionId).toBeDefined();

      // Operator 2 attempts to claim control while Operator 1 is active -> CONTROL_UNAVAILABLE
      op2.send(JSON.stringify({ type: "claim_control", callsign: "W1XYZ" }));
      const claim2 = await nextMessageOfType(op2, "error");
      expect(claim2.code).toBe("CONTROL_UNAVAILABLE");

      // Operator 1 releases control
      op1.send(JSON.stringify({ type: "release_control" }));
      const releaseRes = await nextMessageOfType(op1, "control_released");
      expect(releaseRes.type).toBe("control_released");

      // Operator 2 can now claim control
      op2.send(JSON.stringify({ type: "claim_control", callsign: "W1XYZ" }));
      const claim2Retry = await nextMessageOfType(op2, "control_granted");
      expect(claim2Retry.sessionId).toBeDefined();

      edge.close();
      op1.close();
      op2.close();
    } finally {
      await gateway.close();
    }
  });

  it("persists telemetry and decodes in store and relays commands to edge (R5, R6, F4)", async () => {
    const store = new StationStore();
    const gateway = createCloudGateway({ port: 8903, store });

    try {
      const edge = new WebSocket("ws://127.0.0.1:8903");
      const portal = new WebSocket("ws://127.0.0.1:8903");

      await Promise.all([
        new Promise((resolve) => edge.on("open", resolve)),
        new Promise((resolve) => portal.on("open", resolve))
      ]);

      edge.send(JSON.stringify({ type: "register_edge", stationId: "station-gamma", token: "gamma-tok" }));
      await nextMessageOfType(edge, "edge_registered");

      portal.send(JSON.stringify({ type: "connect_portal", stationId: "station-gamma", token: "gamma-tok" }));
      await nextMessageOfType(portal, "portal_connected");

      // Operator claims control
      portal.send(JSON.stringify({ type: "claim_control" }));
      await nextMessageOfType(portal, "control_granted");

      // Edge streams a decode
      const sampleDecode: DecodeEvent = {
        type: "decode",
        ts: Date.now(),
        snr: -8,
        dt: 0.1,
        af: 1350,
        mode: "FT8",
        message: "CQ DX VK2ABC QF56"
      };
      edge.send(JSON.stringify(sampleDecode));

      // Portal receives broadcasted decode
      const portalDecode = await nextMessageOfType(portal, "decode");
      expect((portalDecode as unknown as DecodeEvent).message).toBe("CQ DX VK2ABC QF56");

      // Store persisted decode
      const saved = store.getDecodes("station-gamma");
      expect(saved).toHaveLength(1);
      expect(saved[0]?.message).toBe("CQ DX VK2ABC QF56");

      // Portal issues transmit command -> relayed to edge
      portal.send(JSON.stringify({
        type: "transmit",
        af: 1350,
        slot: "even",
        message: "VK2ABC K1ABC FN42"
      }));

      const edgeReceived = await nextMessageOfType(edge, "transmit");
      expect(edgeReceived.af).toBe(1350);
      expect(edgeReceived.message).toBe("VK2ABC K1ABC FN42");

      edge.close();
      portal.close();
    } finally {
      await gateway.close();
    }
  });
});
