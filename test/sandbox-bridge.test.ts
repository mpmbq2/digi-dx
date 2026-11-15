import { describe, expect, it } from "vitest";
import { PeripheryHostBridge, type SandboxRpcMessage } from "../src/portal/sandbox/bridge.js";
import { createCoreClient, MockTransportAdapter } from "../core/client/index.js";
import type { DecodeEvent } from "../core/protocol.js";

describe("Sandboxed Periphery Runtime Bridge (U5, R8, R9, R10, R11, AE3)", () => {
  it("relays CoreClient events to sandboxed iframe via postMessage", () => {
    const transport = new MockTransportAdapter();
    const coreClient = createCoreClient(transport);

    const sentToSandbox: SandboxRpcMessage[] = [];
    const bridge = new PeripheryHostBridge({
      coreClient,
      postMessageToSandbox: (msg) => sentToSandbox.push(msg)
    });

    const mockDecode: DecodeEvent = {
      type: "decode",
      ts: 1710000000000,
      snr: -14,
      dt: 0.2,
      af: 1850,
      mode: "FT8",
      message: "CQ DX JA1ABC PM95"
    };

    transport.receive(mockDecode);

    expect(sentToSandbox.length).toBeGreaterThan(0);
    const decodeMsg = sentToSandbox.find(
      (m) => m.type === "rpc_event" && (m.payload as any)?.type === "decode"
    );
    expect(decodeMsg).toBeDefined();
    expect((decodeMsg?.payload as any)?.message).toBe("CQ DX JA1ABC PM95");

    bridge.dispose();
  });

  it("handles valid outbound commands from sandbox and forwards them to CoreClient", () => {
    const transport = new MockTransportAdapter();
    const coreClient = createCoreClient(transport);

    const bridge = new PeripheryHostBridge({
      coreClient,
      postMessageToSandbox: () => {}
    });

    // Sandbox emits a valid transmit command
    bridge.dispatchFromSandbox({
      channel: "digi-dx-periphery",
      type: "rpc_command",
      payload: {
        type: "transmit",
        af: 1400,
        slot: "odd",
        message: "JA1ABC K1ABC FN42"
      }
    });

    const sentCommands = transport.getSentCommands();
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toEqual({
      type: "transmit",
      af: 1400,
      slot: "odd",
      message: "JA1ABC K1ABC FN42"
    });

    bridge.dispose();
  });

  it("blocks unsupported capability calls from sandbox (R10, R13)", () => {
    const transport = new MockTransportAdapter();
    const coreClient = createCoreClient(transport);

    const messagesToSandbox: SandboxRpcMessage[] = [];
    const bridge = new PeripheryHostBridge({
      coreClient,
      postMessageToSandbox: (m) => messagesToSandbox.push(m)
    });

    // Sandbox attempts to call unsupported capability: rotateAntenna
    bridge.dispatchFromSandbox({
      channel: "digi-dx-periphery",
      type: "rpc_command",
      payload: {
        type: "rotateAntenna",
        heading: 180
      }
    });

    // No command forwarded to core radio
    expect(transport.getSentCommands()).toHaveLength(0);

    // Sandbox receives capability rejection with alternative suggestion
    const reject = messagesToSandbox.find(
      (m) => m.type === "rpc_event" && (m.payload as any)?.type === "error"
    );
    expect(reject).toBeDefined();
    expect((reject?.payload as any)?.code).toBe("CAPABILITY_REJECTED");
    expect((reject?.payload as any)?.alternative).toContain("visual heading alert card");

    bridge.dispose();
  });

  it("preserves Policy state and caller queue across Interaction layout swaps (AE3, R8, R9)", () => {
    const transport = new MockTransportAdapter();
    const coreClient = createCoreClient(transport);

    const sentToSandbox: SandboxRpcMessage[] = [];
    const bridge = new PeripheryHostBridge({
      coreClient,
      postMessageToSandbox: (m) => sentToSandbox.push(m)
    });

    // 1. Mount Policy: caller queueing based on distance
    const policyScript = `
      digiDx.on('decode', (d) => {
        const state = digiDx.getPolicyState();
        state.callerQueue.push({ call: 'VK2ABC', distanceKm: 15400 });
        digiDx.setPolicyState(state);
      });
    `;
    bridge.mountPolicy(policyScript);

    // Simulate policy running and synchronizing caller queue
    bridge.dispatchFromSandbox({
      channel: "digi-dx-periphery",
      type: "policy_state_sync",
      state: {
        callerQueue: [
          { call: "VK2ABC", distanceKm: 15400, snr: -10 },
          { call: "JA1XYZ", distanceKm: 10800, snr: -6 }
        ],
        currentQso: { theirCall: "VK2ABC", step: "call-grid" },
        rules: { autoRespondFurthest: true }
      }
    });

    expect(bridge.currentPolicyState.callerQueue).toHaveLength(2);
    expect(bridge.currentPolicyState.callerQueue[0]?.call).toBe("VK2ABC");

    // 2. Operator switches UI from Desktop Layout to Mobile Layout (AE3)
    const mobileLayoutScript = `
      container.innerHTML = '<div class="mobile-view"><h1>Mobile Layout</h1></div>';
    `;
    bridge.mountInteraction(mobileLayoutScript);

    // Check mount_interaction payload sent to sandbox
    const mountMsg = sentToSandbox.find(
      (m) => m.type === "mount_interaction" && m.code === mobileLayoutScript
    );
    expect(mountMsg).toBeDefined();
    // The existing policy state is attached to the new interaction mount without reset
    expect((mountMsg?.state as any).callerQueue).toHaveLength(2);
    expect((mountMsg?.state as any).callerQueue[0]?.call).toBe("VK2ABC");
    expect(bridge.currentPolicyState.callerQueue[0]?.call).toBe("VK2ABC");

    bridge.dispose();
  });
});
