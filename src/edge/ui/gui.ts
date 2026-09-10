import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { EdgePairingService } from "../pairing.js";
import type { AudioDevice } from "../../daemon/audio-devices.js";

// Minimal local GUI server running on the edge machine (R2).
// Exposes local hardware configuration (soundcards, serial ports) and displays
// the ephemeral cloud pairing PIN. It intentionally exposes zero QSO automation
// logic or operating policy.

export interface EdgeGuiOptions {
  port?: number;
  host?: string;
  pairingService: EdgePairingService;
  listAudioDevices: () => Promise<AudioDevice[]>;
  saveConfig?: (config: { deviceId: number; catMode: string; catPort: number }) => Promise<void>;
  getConfig?: () => Promise<{ deviceId?: number; catMode?: string; catPort?: number }>;
}

export interface EdgeGuiServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export function createEdgeGuiServer(options: EdgeGuiOptions): EdgeGuiServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8792;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // CORS headers for local GUI dev/access
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        const pairing = options.pairingService.state;
        const devices = await options.listAudioDevices();
        const config = options.getConfig ? await options.getConfig() : {};

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairing, devices, config }));
        return;
      }

      if (url.pathname === "/api/pairing/code" && req.method === "POST") {
        const { code, expiresAt } = options.pairingService.generatePairingCode();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code, expiresAt }));
        return;
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (options.saveConfig) {
          await options.saveConfig(body as { deviceId: number; catMode: string; catPort: number });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Serve minimal setup HTML page
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLocalHtml());
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(port, host);

  return {
    server,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function renderLocalHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Digi-Dx Edge Radio Setup</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
    h1 { font-size: 1.5rem; margin-top: 0; color: #38bdf8; }
    .pin-display { background: #0284c7; color: #ffffff; font-size: 2.5rem; font-weight: bold; letter-spacing: 0.5rem; text-align: center; padding: 1rem; border-radius: 6px; margin: 1.5rem 0; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #94a3b8; }
    select, input { width: 100%; padding: 0.5rem; border-radius: 4px; background: #334155; border: 1px solid #475569; color: white; margin-top: 0.25rem; box-sizing: border-box; }
    button { background: #0284c7; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; font-weight: 600; cursor: pointer; margin-top: 1.5rem; }
    button:hover { background: #0369a1; }
    .status-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
    .unpaired { background: #eab308; color: #713f12; }
    .paired { background: #22c55e; color: #14532d; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Digi-Dx Edge Setup & Pairing</h1>
    <p>Unitary Edge Radio Client — Hardware & Cloud Connection</p>
    <div id="statusBadge" class="status-badge unpaired">Unpaired</div>
    
    <div class="pin-display" id="pinDisplay">------</div>
    <button id="genBtn" onclick="generateCode()">Generate Pairing Code</button>

    <form id="setupForm" onsubmit="saveSetup(event)">
      <label for="audioSelect">Soundcard Interface</label>
      <select id="audioSelect"></select>

      <label for="catMode">CAT Mode</label>
      <select id="catMode">
        <option value="rigctld">rigctld</option>
        <option value="dummy">dummy</option>
      </select>

      <label for="catPort">CAT Port (rigctld)</label>
      <input type="number" id="catPort" value="4532" />

      <button type="submit">Save Hardware Setup</button>
    </form>
  </div>

  <script>
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      const badge = document.getElementById('statusBadge');
      const pin = document.getElementById('pinDisplay');
      
      badge.className = 'status-badge ' + data.pairing.status;
      badge.textContent = data.pairing.status.toUpperCase();
      if (data.pairing.activeCode) {
        pin.textContent = data.pairing.activeCode;
      }
      
      const audioSelect = document.getElementById('audioSelect');
      audioSelect.innerHTML = '';
      data.devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name + ' (' + d.inputs + ' in, ' + d.outputs + ' out)';
        if (data.config && data.config.deviceId === d.id) opt.selected = true;
        audioSelect.appendChild(opt);
      });
    }

    async function generateCode() {
      const res = await fetch('/api/pairing/code', { method: 'POST' });
      const data = await res.json();
      document.getElementById('pinDisplay').textContent = data.code;
      loadStatus();
    }

    async function saveSetup(e) {
      e.preventDefault();
      const deviceId = Number(document.getElementById('audioSelect').value);
      const catMode = document.getElementById('catMode').value;
      const catPort = Number(document.getElementById('catPort').value);
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, catMode, catPort })
      });
      alert('Hardware settings saved.');
    }

    loadStatus();
    setInterval(loadStatus, 3000);
  </script>
</body>
</html>`;
}
