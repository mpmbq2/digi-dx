import { describe, expect, it } from "vitest";
import {
  createCoreClient,
  MockTransportAdapter,
  PostMessageBridgeAdapter,
  validateCoreCapability,
  CORE_CAPABILITY_SCHEMA
} from "../core/client/index.js";
import type { DecodeEvent, DaemonStatus } from "../core/protocol.js";

describe("CoreClient SDK (U1)", () => {
  it("subscribes to decodes and updates internal state on mock transport events", () => {
    const transport = new MockTransportAdapter();
    const client = createCoreClient(transport, { myCall: "W1AW", myGrid: "FN31" });

    const decodes: DecodeEvent[] = [];
    client.on("decode", (decode) => {
      decodes.push(decode);
    });

    const mockDecode: DecodeEvent = {
      type: "decode",
      ts: 1710000000000,
      snr: -12,
      dt: 0.2,
      af: 1450,
      mode: "FT8",
      message: "CQ DX JA1ABC PM95"
    };

    transport.receive(mockDecode);

    expect(decodes).toHaveLength(1);
    expect(decodes[0]?.message).toBe("CQ DX JA1ABC PM95");
    expect(decodes[0]?.snr).toBe(-12);
  });

  it("updates status, clock, and txState on receiving DaemonStatus", () => {
    const transport = new MockTransportAdapter();
    const client = createCoreClient(transport);

    const mockStatus: DaemonStatus = {
      type: "status",
      engine: "ft8cat",
      clock: {
        epochMs: 0,
        anchorWallMs: 1710000000000,
        slotMs: 15000,
        scale: 1
      },
      session: {
        active: true,
        mode: "FT8",
        device: { id: 1, name: "USB Audio" },
        catConnected: true,
        freq: 14074000,
        ptt: false,
        callsign: "K1ABC",
        grid: "FN42"
      },
      tx: {
        state: "idle",
        af: null,
        slot: null,
        message: null
      },
      control: {
        held: true,
        byThisClient: true
      }
    };

    transport.receive(mockStatus);

    expect(client.status).not.toBeNull();
    expect(client.status?.engine).toBe("ft8cat");
    expect(client.identity.call).toBe("K1ABC");
    expect(client.identity.grid).toBe("FN42");
    expect(client.clock).not.toBeNull();
    expect(client.clock?.spec.slotMs).toBe(15000);
  });

  it("emits serialized transmit commands over the transport", () => {
    const transport = new MockTransportAdapter();
    const client = createCoreClient(transport);

    const ok = client.transmit({
      af: 1200,
      slot: "even",
      message: "CQ K1ABC FN42"
    });

    expect(ok).toBe(true);
    const sent = transport.getSentCommands();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "transmit",
      af: 1200,
      slot: "even",
      message: "CQ K1ABC FN42"
    });
  });

  it("handles haltTx and emergency cancellation", () => {
    const transport = new MockTransportAdapter();
    const client = createCoreClient(transport);

    client.transmit({ af: 1500, slot: "odd", message: "CQ TEST" });
    expect(transport.getSentCommands()).toHaveLength(1);

    const halted = client.haltTx();
    expect(halted).toBe(true);

    const sent = transport.getSentCommands();
    expect(sent[1]).toEqual({ type: "cancel_transmit" });

    // Subsequent transmits should be blocked while txEnabled is false
    const blocked = client.transmit({ af: 1500, slot: "odd", message: "CQ TEST 2" });
    expect(blocked).toBe(false);
    expect(transport.getSentCommands()).toHaveLength(2);
  });

  it("bridges postMessage packets through PostMessageBridgeAdapter", () => {
    const messagesSent: unknown[] = [];
    const fakeWindow = {
      postMessage: (msg: unknown) => {
        messagesSent.push(msg);
      }
    };

    const bridge = new PostMessageBridgeAdapter(fakeWindow);
    const client = createCoreClient(bridge);

    client.transmit({ af: 1800, slot: "even", message: "CQ DX" });

    expect(messagesSent).toHaveLength(1);
    expect(messagesSent[0]).toEqual({
      channel: "digi-dx-sandbox",
      type: "rpc_command",
      payload: {
        type: "transmit",
        af: 1800,
        slot: "even",
        message: "CQ DX"
      }
    });

    // Receive incoming event from window postMessage
    const decodes: DecodeEvent[] = [];
    client.on("decode", (d) => decodes.push(d));

    bridge.dispatchIncoming({
      channel: "digi-dx-sandbox",
      type: "rpc_event",
      payload: {
        type: "decode",
        ts: 12345,
        snr: -5,
        dt: 0.1,
        af: 1800,
        mode: "FT8",
        message: "K1ABC JA1XYZ PM95"
      }
    });

    expect(decodes).toHaveLength(1);
    expect(decodes[0]?.message).toBe("K1ABC JA1XYZ PM95");
  });

  describe("Capability Schema Validation (KTD1, R13, AE2)", () => {
    it("validates core supported methods and events", () => {
      expect(validateCoreCapability("transmit").valid).toBe(true);
      expect(validateCoreCapability("cancelTransmit").valid).toBe(true);
      expect(validateCoreCapability("haltTx").valid).toBe(true);
      expect(validateCoreCapability("decode").valid).toBe(true);
      expect(validateCoreCapability("status").valid).toBe(true);
    });

    it("rejects unsupported capabilities with actionable alternatives (AE2 rotator example)", () => {
      const rotatorResult = validateCoreCapability("rotateAntenna");
      expect(rotatorResult.valid).toBe(false);
      expect(rotatorResult.feature).toBe("antenna_rotator");
      expect(rotatorResult.reason).toContain("Antenna rotator hardware control is not part of the core");
      expect(rotatorResult.alternative).toContain("visual heading alert card");

      const powerResult = validateCoreCapability("setRfPower");
      expect(powerResult.valid).toBe(false);
      expect(powerResult.alternative).toContain("prompt the operator to adjust their rig slider");

      const networkResult = validateCoreCapability("fetch");
      expect(networkResult.valid).toBe(false);
      expect(networkResult.alternative).toContain("postMessage RPC bridge");
    });

    it("rejects completely unknown method names", () => {
      const result = validateCoreCapability("synthesizeAlienSpeech");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("is not recognized");
    });
  });
});
