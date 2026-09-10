import { describe, expect, it } from "vitest";
import { EdgePairingService } from "../src/edge/pairing.js";
import { createEdgeGuiServer } from "../src/edge/ui/gui.ts";
import type { AudioDevice } from "../src/daemon/audio-devices.js";

describe("Edge Pairing Service & Local Setup (U3, R2, R3, F1)", () => {
  it("generates a cryptographic 6-digit PIN with defined expiry", () => {
    const service = new EdgePairingService({ codeLifetimeMs: 5000 });
    expect(service.isPaired).toBe(false);

    const { code, expiresAt } = service.generatePairingCode();

    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(service.state.status).toBe("pairing");
    expect(service.state.activeCode).toBe(code);

    service.dispose();
  });

  it("verifies and claims code, transitioning to paired state", () => {
    const service = new EdgePairingService({ codeLifetimeMs: 10000 });
    const { code } = service.generatePairingCode();

    let pairedEventData: { sessionToken: string; stationId: string } | null = null;
    service.on("paired", (data) => {
      pairedEventData = data;
    });

    // Attempt with incorrect code fails
    const badClaim = service.verifyAndClaim("000000", "auth_token_xyz");
    expect(badClaim).toBe(false);
    expect(service.isPaired).toBe(false);

    // Attempt with correct code succeeds
    const ok = service.verifyAndClaim(code, "auth_token_xyz");
    expect(ok).toBe(true);
    expect(service.isPaired).toBe(true);
    expect(service.state.status).toBe("paired");
    expect(service.state.sessionToken).toBe("auth_token_xyz");
    expect(service.state.activeCode).toBeNull();
    expect(pairedEventData).not.toBeNull();
    expect(pairedEventData?.sessionToken).toBe("auth_token_xyz");

    // Once paired, claiming again returns false
    expect(service.verifyAndClaim(code, "another_token")).toBe(false);

    service.dispose();
  });

  it("expires active pairing code after timeout", async () => {
    const service = new EdgePairingService({ codeLifetimeMs: 50 });
    const { code } = service.generatePairingCode();

    let expiredFired = false;
    service.on("expired", () => {
      expiredFired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(expiredFired).toBe(true);
    expect(service.state.status).toBe("unpaired");
    expect(service.state.activeCode).toBeNull();

    // Claiming an expired code fails
    expect(service.verifyAndClaim(code, "token")).toBe(false);

    service.dispose();
  });

  it("supports unpairing and resetting credentials", () => {
    const service = new EdgePairingService();
    const { code } = service.generatePairingCode();
    service.verifyAndClaim(code, "token123");
    expect(service.isPaired).toBe(true);

    let unpairFired = false;
    service.on("unpaired", () => {
      unpairFired = true;
    });

    service.unpair();
    expect(service.isPaired).toBe(false);
    expect(service.state.status).toBe("unpaired");
    expect(service.state.sessionToken).toBeNull();
    expect(unpairFired).toBe(true);

    service.dispose();
  });

  it("serves minimal local setup API without exposing QSO or policy automation (R2)", async () => {
    const pairingService = new EdgePairingService();
    const mockDevices: AudioDevice[] = [
      { id: 1, name: "USB Audio CODEC", inputs: 2, outputs: 2, defaultSampleRate: 48000 }
    ];

    let savedConfig: unknown = null;
    const gui = createEdgeGuiServer({
      port: 8793,
      pairingService,
      listAudioDevices: async () => mockDevices,
      saveConfig: async (cfg) => {
        savedConfig = cfg;
      },
      getConfig: async () => ({ deviceId: 1, catMode: "rigctld", catPort: 4532 })
    });

    try {
      // Test GET /api/status
      const statusRes = await fetch(`${gui.url}/api/status`);
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        pairing: { status: string };
        devices: AudioDevice[];
        config: { deviceId: number };
      };
      expect(statusJson.pairing.status).toBe("unpaired");
      expect(statusJson.devices).toHaveLength(1);
      expect(statusJson.devices[0]?.name).toBe("USB Audio CODEC");
      expect(statusJson.config.deviceId).toBe(1);

      // Verify no QSO automation or policy endpoints are exposed
      const qsoRes = await fetch(`${gui.url}/api/qso`);
      expect(qsoRes.status).toBe(404);

      // Test POST /api/pairing/code
      const codeRes = await fetch(`${gui.url}/api/pairing/code`, { method: "POST" });
      expect(codeRes.status).toBe(200);
      const codeJson = (await codeRes.json()) as { code: string };
      expect(codeJson.code).toMatch(/^\d{6}$/);
      expect(pairingService.state.activeCode).toBe(codeJson.code);

      // Test POST /api/config
      const configRes = await fetch(`${gui.url}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: 1, catMode: "dummy", catPort: 0 })
      });
      expect(configRes.status).toBe(200);
      expect(savedConfig).toEqual({ deviceId: 1, catMode: "dummy", catPort: 0 });
    } finally {
      await gui.close();
      pairingService.dispose();
    }
  });
});
