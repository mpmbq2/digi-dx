import { describe, expect, it } from "vitest";
import { StockPolicy, calculateGridDistance } from "../src/portal/stock/policy.js";
import { renderStockUiScript } from "../src/portal/stock/ui.js";
import type { DecodeEvent } from "../core/protocol.js";

describe("Stock Policy & Interaction Layers (U6, R15, R16, F3, AE4)", () => {
  it("calculates Maidenhead grid square distance accurately", () => {
    // Distance between FN31 (Boston area) and PM95 (Tokyo area) ~ 10,800 km
    const distTokyo = calculateGridDistance("FN31", "PM95");
    expect(distTokyo).toBeGreaterThan(10000);
    expect(distTokyo).toBeLessThan(12000);

    // Distance between FN31 and FN31 (same square) = 0
    expect(calculateGridDistance("FN31", "FN31")).toBe(0);
  });

  it("queues and prioritizes callers answering CQ by distance and new grid", () => {
    const policy = new StockPolicy({ autoReply: true, prioritizeDistance: true });

    // Incoming responder 1: Nearer station (FN20 ~ 200 km)
    const decodeNear: DecodeEvent = {
      type: "decode",
      ts: 1710000000000,
      snr: -5,
      dt: 0.1,
      af: 1200,
      mode: "FT8",
      message: "W1AW K2ABC FN20"
    };

    // Incoming responder 2: Farther DX station (PM95 ~ 10,800 km)
    const decodeDx: DecodeEvent = {
      type: "decode",
      ts: 1710000000000,
      snr: -12,
      dt: 0.2,
      af: 1500,
      mode: "FT8",
      message: "W1AW JA1XYZ PM95"
    };

    policy.handleDecode(decodeNear, "W1AW", "FN31");
    policy.handleDecode(decodeDx, "W1AW", "FN31");

    const queue = policy.callerQueue;
    expect(queue).toHaveLength(2);
    // Farther DX station ranked first
    expect(queue[0]?.call).toBe("JA1XYZ");
    expect(queue[0]?.distanceKm).toBeGreaterThan(10000);
    expect(queue[1]?.call).toBe("K2ABC");
  });

  it("progresses active QSO contact state cleanly", () => {
    const policy = new StockPolicy();

    policy.handleDecode(
      {
        type: "decode",
        ts: 100,
        snr: -10,
        dt: 0.1,
        af: 1200,
        mode: "FT8",
        message: "W1AW VK2ABC QF56"
      },
      "W1AW",
      "FN31"
    );

    expect(policy.callerQueue).toHaveLength(1);

    // Start QSO with queued station
    const qso = policy.startQso("VK2ABC", 1200, "even");
    expect(qso).not.toBeNull();
    expect(qso?.theirCall).toBe("VK2ABC");
    expect(qso?.step).toBe("call-grid");
    // Station popped from queue into active contact
    expect(policy.callerQueue).toHaveLength(0);

    // Advance steps
    policy.advanceQso("report");
    expect(policy.currentQso?.step).toBe("report");

    policy.advanceQso("complete");
    expect(policy.currentQso?.step).toBe("complete");

    policy.finishQso();
    expect(policy.currentQso).toBeNull();
  });

  it("dynamically updates policy parameter for 73 audio beep without losing state (AE4)", () => {
    const policy = new StockPolicy({ alertOn73: false });

    // Start an active contact
    policy.startQso("DL1ABC", 1400, "odd");
    expect(policy.currentQso?.theirCall).toBe("DL1ABC");

    // Message with 73 arrives before alert is enabled
    const res1 = policy.handleDecode(
      {
        type: "decode",
        ts: 200,
        snr: -8,
        dt: 0.1,
        af: 1400,
        mode: "FT8",
        message: "W1AW DL1ABC 73"
      },
      "W1AW",
      "FN31"
    );
    expect(res1.alert).toBeUndefined();
    expect(policy.recentAlerts).toHaveLength(0);

    // Operator opens agent panel and asks: "Add an audio beep whenever someone sends 73 to me" (AE4)
    policy.updateConfig({ alertOn73: true, audioBeepEnabled: true });
    expect(policy.currentConfig.alertOn73).toBe(true);
    // Active contact is still intact
    expect(policy.currentQso?.theirCall).toBe("DL1ABC");

    // Another 73 arrives
    const res2 = policy.handleDecode(
      {
        type: "decode",
        ts: 300,
        snr: -8,
        dt: 0.1,
        af: 1400,
        mode: "FT8",
        message: "W1AW DL1ABC 73"
      },
      "W1AW",
      "FN31"
    );

    expect(res2.alert).toContain("BEEP: 73 received from DL1ABC");
    expect(policy.recentAlerts).toContain("BEEP: 73 received from DL1ABC");
  });

  it("renders stock UI script bundle containing key UI components", () => {
    const script = renderStockUiScript();
    expect(script).toContain("Priority Caller Queue");
    expect(script).toContain("Active Contact");
    expect(script).toContain("Live Decodes");
    expect(script).toContain("btn-call-cq");
    expect(script).toContain("btn-halt");
    expect(script).toContain("digiDx.on('policyStateChange'");
  });
});
