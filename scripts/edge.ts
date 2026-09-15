import { bootstrapEdgeClient } from "../src/edge/index.js";

function parseArgs(argv: string[]): {
  ui: "gui" | "tui" | "headless";
  port: number;
  host: string;
  sim: boolean;
  cloud?: string;
  config?: string;
  help: boolean;
} {
  let ui: "gui" | "tui" | "headless" = "gui";
  let port = 8792;
  let host = "0.0.0.0";
  let sim = process.env.DIGI_DX_ENGINE === "sim";
  let cloud = process.env.DIGI_DX_CLOUD_URL;
  let config = process.env.DIGI_DX_CONFIG_PATH;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--sim") {
      sim = true;
    } else if (arg === "--ui" && (next === "gui" || next === "tui" || next === "headless")) {
      ui = next;
      i += 1;
    } else if (arg === "--port" && Number.isInteger(Number(next))) {
      port = Number(next);
      i += 1;
    } else if (arg === "--host" && next) {
      host = next;
      i += 1;
    } else if (arg === "--cloud" && next) {
      cloud = next;
      i += 1;
    } else if (arg === "--config" && next) {
      config = next;
      i += 1;
    }
  }

  return { ui, port, host, sim, cloud, config, help };
}

function printUsage(): void {
  console.log(`Usage: npm run edge -- [options]

Starts the Digi-Dx Unitary Edge Client for radio transceiver interfacing and diagnostics.

Options:
  --ui <gui|tui|headless>  Local interface mode (default: gui)
                            - gui: Serves local web dashboard (monitor-attached or LAN browser)
                            - tui: Starts Blessed terminal UI in current terminal (headless SSH)
                            - headless: Runs edge background service with HTTP API only
  --port <number>          Port for local GUI server (default: 8792)
  --host <string>          Bind address for local GUI server (default: 0.0.0.0)
  --sim                    Force simulated engine (radio-less demo/testing mode)
  --cloud <url>            Remote Digi-Dx Cloud Gateway WebSocket URL
  --config <path>          Path to local station config JSON
  --help, -h               Show this help message
`);
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  printUsage();
  process.exit(0);
}

const client = await bootstrapEdgeClient({
  ui: parsed.ui === "headless" ? "none" : parsed.ui,
  guiPort: parsed.port,
  guiHost: parsed.host,
  forceSimulated: parsed.sim,
  cloudUrl: parsed.cloud,
  configPath: parsed.config
});

if (parsed.ui !== "tui") {
  console.info("-------------------------------------------------------");
  console.info("📡 Digi-Dx Unitary Edge Client running");
  console.info(`   UI Mode:     ${parsed.ui}`);
  if (client.gui) console.info(`   Local GUI:   http://${parsed.host}:${parsed.port}`);
  console.info(`   Engine:      ${parsed.sim ? "simulated" : "live (ft8cat / hamlib)"}`);
  console.info(`   Station ID:  ${client.runtime.getTelemetry().server.stationId}`);
  console.info("-------------------------------------------------------");
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parsed.ui !== "tui") console.info(`\nReceived ${signal}, shutting down...`);
  try {
    await client.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
