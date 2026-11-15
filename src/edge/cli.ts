import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapEdgeClient } from "./index.js";

export interface ParsedEdgeCliArgs {
  ui: "gui" | "tui" | "headless";
  port: number;
  host: string;
  sim: boolean;
  cloud?: string;
  config?: string;
  help: boolean;
}

export function parseEdgeCliArgs(argv: string[]): ParsedEdgeCliArgs {
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
    } else if (arg === "--tui") {
      ui = "tui";
    } else if (arg === "--gui") {
      ui = "gui";
    } else if (arg === "--headless") {
      ui = "headless";
    } else if (arg.startsWith("--ui=")) {
      const val = arg.slice(5);
      if (val === "gui" || val === "tui" || val === "headless") {
        ui = val;
      }
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
  --tui, --gui, --headless Shorthand flags for --ui mode
  --port <number>          Port for local GUI server (default: 8792)
  --host <string>          Bind address for local GUI server (default: 0.0.0.0)
  --sim                    Force simulated engine (radio-less demo/testing mode)
  --cloud <url>            Remote Digi-Dx Cloud Gateway WebSocket URL
  --config <path>          Path to local station config JSON
  --help, -h               Show this help message
`);
}

export async function runEdgeCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseEdgeCliArgs(argv);
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  const isTui = parsed.ui === "tui";
  let shuttingDown = false;
  let client: Awaited<ReturnType<typeof bootstrapEdgeClient>> | null = null;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!isTui) console.info(`\nReceived ${signal}, shutting down...`);
    try {
      await client?.stop();
    } finally {
      process.exit(0);
    }
  }

  client = await bootstrapEdgeClient({
    ui: parsed.ui === "headless" ? "none" : parsed.ui,
    guiPort: parsed.port,
    guiHost: parsed.host,
    forceSimulated: parsed.sim,
    cloudUrl: parsed.cloud,
    configPath: parsed.config,
    logger: isTui ? { info: () => {}, warn: () => {}, error: () => {} } : console,
    onQuit: async () => {
      await shutdown("QUIT");
    }
  });

  if (!isTui) {
    console.info("-------------------------------------------------------");
    console.info("📡 Digi-Dx Unitary Edge Client running");
    console.info(`   UI Mode:     ${parsed.ui}`);
    if (client.gui) console.info(`   Local GUI:   http://${parsed.host}:${parsed.port}`);
    console.info(`   Engine:      ${parsed.sim ? "simulated" : "live (ft8cat / hamlib)"}`);
    console.info(`   Station ID:  ${client.runtime.getTelemetry().server.stationId}`);
    console.info("-------------------------------------------------------");
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isEntrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await runEdgeCli();
}
