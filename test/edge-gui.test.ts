import { describe, expect, it } from "vitest";
import { EdgeRuntime } from "../src/edge/runtime.js";
import { createEdgeGuiServer } from "../src/edge/ui/gui.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Edge GUI Server & Dashboard (5 Diagnostic Pillars)", () => {
  it("serves HTML dashboard and full REST/telemetry API", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "edge-gui-test-"));
    const configPath = join(tmpDir, "config.json");

    const runtime = new EdgeRuntime({
      configPath,
      forceSimulated: true
    });
    await runtime.init();

    // Use ephemeral port 0
    const gui = createEdgeGuiServer({
      port: 0,
      host: "127.0.0.1",
      runtime
    });

    if (!gui.server.listening) {
      await new Promise((resolve) => gui.server.once("listening", resolve));
    }
    const baseUrl = gui.url;

    // 1. GET / (HTML dashboard)
    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("Digi-Dx Edge Radio Client");
    expect(html).toContain("Cloud Connection & Pairing");
    expect(html).toContain("Radio & CAT Control");
    expect(html).toContain("FT8 Modem & Audio DSP");
    expect(html).toContain("Station & Hardware Configuration");

    // 2. GET /api/telemetry
    const telemRes = await fetch(`${baseUrl}/api/telemetry`);
    expect(telemRes.status).toBe(200);
    const telem = await telemRes.json();
    expect(telem.program.version).toBe("0.1.0");
    expect(telem.radio).toBeDefined();
    expect(telem.server).toBeDefined();
    expect(telem.ft8).toBeDefined();

    // 3. GET /api/devices
    const devRes = await fetch(`${baseUrl}/api/devices`);
    expect(devRes.status).toBe(200);
    const devices = await devRes.json();
    expect(Array.isArray(devices)).toBe(true);

    // 4. POST /api/pairing/code
    const pinRes = await fetch(`${baseUrl}/api/pairing/code`, { method: "POST" });
    expect(pinRes.status).toBe(200);
    const pinData = await pinRes.json();
    expect(pinData.code).toMatch(/^\d{6}$/);

    // 5. POST /api/config
    const cfgRes = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callsign: "K1ABC",
        grid: "FN20",
        deviceId: 0,
        catMode: "dummy",
        catPort: 4532,
        cloudUrl: "ws://127.0.0.1:8795"
      })
    });
    expect(cfgRes.status).toBe(200);
    expect((await cfgRes.json()).ok).toBe(true);

    // 6. POST /api/cat/test
    const catRes = await fetch(`${baseUrl}/api/cat/test`, { method: "POST" });
    expect(catRes.status).toBe(200);
    const catData = await catRes.json();
    expect(catData.ok).toBe(true);

    // 7. POST /api/cat/ptt-test
    const pttRes = await fetch(`${baseUrl}/api/cat/ptt-test`, { method: "POST" });
    expect(pttRes.status).toBe(200);
    const pttData = await pttRes.json();
    expect(pttData.ok).toBe(true);

    await gui.close();
    await runtime.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
