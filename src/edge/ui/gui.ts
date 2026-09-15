import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { EdgePairingService } from "../pairing.js";
import type { AudioDevice } from "../../daemon/audio-devices.js";
import { type EdgeRuntime, createInitialTelemetry } from "../runtime.js";

// Comprehensive local GUI server running on the edge machine (R2).
// Exposes live health and configuration across the 5 diagnostic pillars:
// 1. Program & Watchdog Status
// 2. Configuration Setup
// 3. Server / Cloud Communication
// 4. Radio CAT Communication
// 5. FT8 Engine & Audio DSP

export interface EdgeGuiOptions {
  port?: number;
  host?: string;
  runtime?: EdgeRuntime;
  pairingService?: EdgePairingService;
  listAudioDevices?: () => Promise<AudioDevice[]>;
  saveConfig?: (config: { deviceId: number; catMode: string; catPort: number; callsign?: string; grid?: string; cloudUrl?: string }) => Promise<void>;
  getConfig?: () => Promise<{ deviceId?: number; catMode?: string; catPort?: number; callsign?: string; grid?: string }>;
  testCat?: () => Promise<{ ok: boolean; freqHz: number | null; catConnected: boolean; error?: string }>;
  testPtt?: (durationMs?: number) => Promise<{ ok: boolean; error?: string }>;
}

export interface EdgeGuiServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export function createEdgeGuiServer(options: EdgeGuiOptions): EdgeGuiServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8792;
  const runtime = options.runtime;
  const sseClients = new Set<ServerResponse>();

  if (runtime) {
    runtime.on("telemetry", (telem) => {
      const payload = `data: ${JSON.stringify(telem)}\n\n`;
      for (const res of sseClients) {
        try {
          res.write(payload);
        } catch {
          sseClients.delete(res);
        }
      }
    });
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      // Live Server-Sent Events (SSE) telemetry stream
      if (url.pathname === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": ok\n\n");
        sseClients.add(res);
        if (runtime) res.write(`data: ${JSON.stringify(runtime.getTelemetry())}\n\n`);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // Status and telemetry
      if (url.pathname === "/api/status" && req.method === "GET") {
        const telem = runtime ? runtime.getTelemetry() : createInitialTelemetry(options.pairingService?.state.stationId);
        const pairing = options.pairingService?.state ?? telem.server;
        const devices = runtime ? await runtime.listAudioDevices() : options.listAudioDevices ? await options.listAudioDevices() : [];
        const config = options.getConfig ? await options.getConfig() : telem.config;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairing, devices, config, telemetry: telem }));
        return;
      }

      if (url.pathname === "/api/telemetry" && req.method === "GET") {
        const telem = runtime ? runtime.getTelemetry() : createInitialTelemetry(options.pairingService?.state.stationId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(telem));
        return;
      }

      if (url.pathname === "/api/devices" && req.method === "GET") {
        const devices = runtime ? await runtime.listAudioDevices() : options.listAudioDevices ? await options.listAudioDevices() : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(devices));
        return;
      }

      // Generate pairing PIN
      if (url.pathname === "/api/pairing/code" && req.method === "POST") {
        const result = runtime
          ? runtime.generatePairingCode()
          : options.pairingService?.generatePairingCode() ?? { code: "000000", expiresAt: Date.now() + 300000 };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // Save station configuration
      if (url.pathname === "/api/config" && req.method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (runtime) {
          await runtime.saveConfig({
            callsign: typeof body.callsign === "string" ? body.callsign : undefined,
            grid: typeof body.grid === "string" ? body.grid : undefined,
            cloudUrl: typeof body.cloudUrl === "string" ? body.cloudUrl : undefined,
            device: { id: Number(body.deviceId ?? 0), name: typeof body.deviceName === "string" ? body.deviceName : undefined },
            cat: { mode: body.catMode === "dummy" ? "dummy" : "rigctld", port: Number(body.catPort ?? 4532) }
          });
        } else if (options.saveConfig) {
          await options.saveConfig(body as any);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // CAT and PTT diagnostics
      if (url.pathname === "/api/cat/test" && req.method === "POST") {
        const result = runtime ? await runtime.testCat() : options.testCat ? await options.testCat() : { ok: true, freqHz: 14074000, catConnected: true };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/cat/ptt-test" && req.method === "POST") {
        const result = runtime ? await runtime.testPtt(200) : options.testPtt ? await options.testPtt(200) : { ok: true };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // Minimal responsive dashboard HTML
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboardHtml());
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(port, host);

  return {
    server,
    get url(): string {
      const addr = server.address();
      return addr && typeof addr === "object" ? `http://${host}:${addr.port}` : `http://${host}:${port}`;
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const res of sseClients) res.end();
        sseClients.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Digi-Dx Edge Radio Client</title>
  <style>
    :root {
      --bg: #0a0f1d; --card: #131c31; --border: #1e293b; --text: #f8fafc; --muted: #94a3b8;
      --cyan: #0ea5e9; --green: #10b981; --amber: #f59e0b; --rose: #f43f5e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 1.25rem; }
    .wrap { max-width: 1050px; margin: 0 auto; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.25rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
    h1 { font-size: 1.3rem; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.05em; }
    .badges { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .badge { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .b-green { background: rgba(16,185,129,0.15); color: var(--green); }
    .b-amber { background: rgba(245,158,11,0.15); color: var(--amber); }
    .b-rose { background: rgba(244,63,94,0.15); color: var(--rose); }
    .b-cyan { background: rgba(14,165,233,0.15); color: var(--cyan); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.1rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .card-hdr { display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; font-weight: 600; color: var(--cyan); border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.4rem; }
    .row { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; }
    .val { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pin-box { background: #0d1527; border: 2px dashed var(--cyan); border-radius: 6px; padding: 1rem; text-align: center; margin: 0.25rem 0; }
    .pin-code { font-size: 2.2rem; font-weight: 800; letter-spacing: 0.35rem; color: #38bdf8; font-family: monospace; }
    .bar-wrap { background: #0d1527; border-radius: 4px; height: 10px; overflow: hidden; margin: 0.35rem 0; }
    .bar-fill { height: 100%; background: var(--cyan); width: 0%; transition: width 0.3s ease; }
    label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--muted); }
    input, select { background: #1e293b; border: 1px solid #334155; color: var(--text); padding: 0.45rem 0.65rem; border-radius: 4px; font-size: 0.85rem; }
    input:focus, select:focus { outline: none; border-color: var(--cyan); }
    button { background: #0284c7; color: white; border: none; padding: 0.5rem 0.9rem; border-radius: 4px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #0369a1; }
    button.btn-sec { background: #334155; }
    button.btn-sec:hover { background: #475569; }
    button.btn-warn { background: #d97706; }
    button.btn-warn:hover { background: #b45309; }
    .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #1e293b; border-left: 4px solid var(--cyan); padding: 0.75rem 1.25rem; border-radius: 4px; font-size: 0.85rem; display: none; z-index: 1000; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Digi-Dx Edge Radio Client</h1>
        <p style="font-size: 0.8rem; color: var(--muted);">Unitary Hardware Appliance · Radio CAT, Audio DSP & Cloud Link</p>
      </div>
      <div class="badges">
        <div class="badge b-amber" id="bCloud"><span class="dot"></span>Cloud: Unpaired</div>
        <div class="badge b-amber" id="bCat"><span class="dot"></span>CAT: Offline</div>
        <div class="badge b-cyan" id="bFt8"><span class="dot"></span>FT8: Inactive</div>
        <div class="badge b-green" id="bPtt"><span class="dot"></span>RX Idle</div>
        <div class="badge b-green" id="bWd"><span class="dot"></span>Watchdog OK</div>
      </div>
    </header>

    <div class="grid">
      <!-- 1. Cloud Gateway & Pairing -->
      <section class="card">
        <div class="card-hdr">
          <span>◆ Cloud Connection & Pairing</span>
          <span class="badge b-amber" id="pairBadge">UNPAIRED</span>
        </div>
        <div class="pin-box">
          <div style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">6-Digit Pairing Code</div>
          <div class="pin-code" id="pinDisp">------</div>
          <div style="font-size: 0.75rem; color: var(--amber); margin-top: 0.2rem;" id="pinExp">Press Generate to create a PIN</div>
        </div>
        <div class="row"><span style="color: var(--muted);">Station ID</span><span class="val" id="stationIdVal">—</span></div>
        <div class="row"><span style="color: var(--muted);">Gateway Link</span><span class="val" id="gwVal">Disconnected</span></div>
        <div class="row"><span style="color: var(--muted);">Round-Trip Latency</span><span class="val" id="pingVal">—</span></div>
        <button onclick="genPin()" style="margin-top: 0.25rem;">Generate New PIN</button>
      </section>

      <!-- 2. Radio & CAT Control -->
      <section class="card">
        <div class="card-hdr">
          <span>◆ Radio & CAT Control</span>
          <span class="badge b-amber" id="catBadge">OFFLINE</span>
        </div>
        <div class="row"><span style="color: var(--muted);">Dial Frequency</span><span class="val" id="freqVal" style="font-size: 1.15rem; color: var(--cyan);">—</span></div>
        <div class="row"><span style="color: var(--muted);">CAT Protocol</span><span class="val" id="catProtoVal">rigctld :4532</span></div>
        <div class="row"><span style="color: var(--muted);">PTT State</span><span class="val" id="pttVal">RX Idle</span></div>
        <div class="row"><span style="color: var(--muted);">Diagnostic Status</span><span class="val" id="catDiagVal">Ready</span></div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.25rem;">
          <button class="btn-sec" onclick="testCat()">Test CAT Query</button>
          <button class="btn-warn" onclick="testPtt()">Test PTT (Safe 200ms)</button>
        </div>
      </section>

      <!-- 3. FT8 Engine & Audio DSP -->
      <section class="card">
        <div class="card-hdr">
          <span>◆ FT8 Modem & Audio DSP</span>
          <span class="badge b-cyan" id="engineBadge">FT8CAT</span>
        </div>
        <div class="row"><span style="color: var(--muted);">Slot Cycle</span><span class="val" id="slotVal">EVEN (15s left)</span></div>
        <div class="bar-wrap"><div class="bar-fill" id="slotFill"></div></div>
        <div class="row"><span style="color: var(--muted);">Decodes (Current Slot)</span><span class="val" id="slotDecodesVal">0</span></div>
        <div class="row"><span style="color: var(--muted);">Total Decodes</span><span class="val" id="totDecodesVal">0</span></div>
        <div class="row"><span style="color: var(--muted);">Latest Message</span><span class="val" id="lastMsgVal" style="color: #38bdf8;">None</span></div>
      </section>

      <!-- 4. Hardware Setup Form -->
      <section class="card" style="grid-column: 1 / -1;">
        <div class="card-hdr"><span>⚙ Station & Hardware Configuration</span><span style="font-size: 0.75rem; color: var(--muted);">Saved to edge config</span></div>
        <form id="cfgForm" onsubmit="saveCfg(event)" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem;">
          <label>Callsign<input type="text" id="cfgCall" placeholder="e.g. N1MPM" required spellcheck="false" /></label>
          <label>Maidenhead Grid<input type="text" id="cfgGrid" placeholder="e.g. FN31" required spellcheck="false" /></label>
          <label>Soundcard Interface<select id="cfgDev"></select></label>
          <label>CAT Mode<select id="cfgCatMode"><option value="rigctld">rigctld (Hamlib)</option><option value="dummy">dummy (simulation)</option></select></label>
          <label>CAT Port (rigctld)<input type="number" id="cfgCatPort" value="4532" min="1" max="65535" required /></label>
          <label>Cloud Gateway URL<input type="text" id="cfgCloud" placeholder="ws://127.0.0.1:8795" /></label>
          <div style="grid-column: 1 / -1; display: flex; justify-content: flex-end; margin-top: 0.25rem;">
            <button type="submit">Save & Apply Configuration</button>
          </div>
        </form>
      </section>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(msg, dur = 3000) {
      const t = document.getElementById('toast');
      t.textContent = msg; t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, dur);
    }

    function applyTelemetry(t) {
      const bCloud = document.getElementById('bCloud');
      bCloud.className = 'badge ' + (t.server.connected ? 'b-green' : (t.server.status === 'pairing' ? 'b-amber' : 'b-rose'));
      bCloud.innerHTML = '<span class="dot"></span>Cloud: ' + t.server.status.toUpperCase();

      const bCat = document.getElementById('bCat');
      bCat.className = 'badge ' + (t.radio.catConnected ? 'b-green' : 'b-amber');
      bCat.innerHTML = '<span class="dot"></span>CAT: ' + (t.radio.catConnected ? 'ONLINE' : 'OFFLINE');

      const bFt8 = document.getElementById('bFt8');
      bFt8.className = 'badge ' + (t.ft8.sessionActive ? 'b-cyan' : 'b-amber');
      bFt8.innerHTML = '<span class="dot"></span>FT8: ' + (t.ft8.sessionActive ? 'ACTIVE' : 'IDLE');

      const bPtt = document.getElementById('bPtt');
      bPtt.className = 'badge ' + (t.radio.ptt ? 'b-rose' : 'b-green');
      bPtt.innerHTML = '<span class="dot"></span>' + (t.radio.ptt ? 'TX TRANSMITTING' : 'RX IDLE');

      const bWd = document.getElementById('bWd');
      bWd.className = 'badge ' + (t.watchdog.hasTimedOut ? 'b-rose' : 'b-green');
      bWd.innerHTML = '<span class="dot"></span>Watchdog: ' + (t.watchdog.hasTimedOut ? 'ABORTED' : 'OK');

      document.getElementById('pairBadge').textContent = t.server.status.toUpperCase();
      document.getElementById('pairBadge').className = 'badge ' + (t.server.connected ? 'b-green' : 'b-amber');
      document.getElementById('pinDisp').textContent = t.server.activeCode || (t.server.connected ? 'PAIRED' : '------');
      document.getElementById('pinExp').textContent = t.server.activeCode ? 'Expires in ' + (t.server.codeExpiresInSec || 0) + 's' : (t.server.connected ? 'Radio paired with cloud gateway' : 'Press Generate to create a PIN');
      document.getElementById('stationIdVal').textContent = t.server.stationId || '—';
      document.getElementById('gwVal').textContent = t.server.connected ? 'Connected' : 'Disconnected';
      document.getElementById('pingVal').textContent = t.server.pingMs != null ? t.server.pingMs + ' ms' : '—';

      document.getElementById('catBadge').textContent = t.radio.catConnected ? 'ONLINE' : 'OFFLINE';
      document.getElementById('catBadge').className = 'badge ' + (t.radio.catConnected ? 'b-green' : 'b-amber');
      document.getElementById('freqVal').textContent = t.radio.freqHz ? (t.radio.freqHz / 1e6).toFixed(3) + ' MHz' : '—';
      document.getElementById('catProtoVal').textContent = t.config.catMode + ' :' + t.config.catPort;
      document.getElementById('pttVal').textContent = t.radio.ptt ? 'TX TRANSMITTING' : 'RX Idle';
      document.getElementById('catDiagVal').textContent = t.radio.catError || (t.radio.catConnected ? 'Connected' : 'Ready');

      document.getElementById('engineBadge').textContent = t.ft8.engineKind.toUpperCase();
      document.getElementById('slotVal').textContent = t.ft8.slotParity.toUpperCase() + ' (' + t.ft8.slotSecondsRemaining + 's left)';
      document.getElementById('slotFill').style.width = Math.round(((15 - t.ft8.slotSecondsRemaining) / 15) * 100) + '%';
      document.getElementById('slotDecodesVal').textContent = t.ft8.decodesThisSlot;
      document.getElementById('totDecodesVal').textContent = t.ft8.totalDecodes;
      document.getElementById('lastMsgVal').textContent = t.ft8.lastDecodeMessage || 'None';

      if (!window._initDone && t.config) {
        window._initDone = true;
        if (t.config.callsign) document.getElementById('cfgCall').value = t.config.callsign;
        if (t.config.grid) document.getElementById('cfgGrid').value = t.config.grid;
        if (t.config.catMode) document.getElementById('cfgCatMode').value = t.config.catMode;
        if (t.config.catPort) document.getElementById('cfgCatPort').value = t.config.catPort;
        if (t.config.cloudUrl) document.getElementById('cfgCloud').value = t.config.cloudUrl;
      }
    }

    async function loadDevs() {
      try {
        const res = await fetch('/api/devices');
        const devs = await res.json();
        const sel = document.getElementById('cfgDev');
        sel.innerHTML = '';
        devs.forEach(d => {
          const o = document.createElement('option');
          o.value = d.id; o.textContent = '[' + d.id + '] ' + d.name + ' (' + d.inputs + 'in/' + d.outputs + 'out)';
          sel.appendChild(o);
        });
      } catch {}
    }

    async function genPin() {
      try {
        const res = await fetch('/api/pairing/code', { method: 'POST' });
        const d = await res.json();
        document.getElementById('pinDisp').textContent = d.code;
        showToast('Generated PIN: ' + d.code);
        refresh();
      } catch (err) { showToast('Error: ' + err.message); }
    }

    async function testCat() {
      showToast('Testing CAT...');
      try {
        const res = await fetch('/api/cat/test', { method: 'POST' });
        const d = await res.json();
        showToast(d.ok ? 'CAT OK: ' + (d.freqHz ? (d.freqHz / 1e6).toFixed(3) + ' MHz' : 'connected') : 'CAT Failed: ' + (d.error || 'error'));
        refresh();
      } catch (err) { showToast('CAT Error: ' + err.message); }
    }

    async function testPtt() {
      if (!confirm('Key safe 200ms PTT pulse test?')) return;
      try {
        const res = await fetch('/api/cat/ptt-test', { method: 'POST' });
        const d = await res.json();
        showToast(d.ok ? 'PTT Pulse Succeeded' : 'PTT Failed: ' + (d.error || 'error'));
        refresh();
      } catch (err) { showToast('PTT Error: ' + err.message); }
    }

    async function saveCfg(e) {
      e.preventDefault();
      const callsign = document.getElementById('cfgCall').value.trim();
      const grid = document.getElementById('cfgGrid').value.trim();
      const deviceId = Number(document.getElementById('cfgDev').value);
      const catMode = document.getElementById('cfgCatMode').value;
      const catPort = Number(document.getElementById('cfgCatPort').value);
      const cloudUrl = document.getElementById('cfgCloud').value.trim();
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callsign, grid, deviceId, catMode, catPort, cloudUrl })
        });
        const d = await res.json();
        showToast(d.ok ? 'Settings saved successfully' : 'Save failed');
        refresh();
      } catch (err) { showToast('Error: ' + err.message); }
    }

    async function refresh() {
      try {
        const res = await fetch('/api/telemetry');
        applyTelemetry(await res.json());
      } catch {}
    }

    try {
      const es = new EventSource('/api/stream');
      es.onmessage = (e) => { try { applyTelemetry(JSON.parse(e.data)); } catch {} };
      es.onerror = () => setTimeout(refresh, 2000);
    } catch {
      setInterval(refresh, 1000);
    }

    loadDevs();
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;
}
