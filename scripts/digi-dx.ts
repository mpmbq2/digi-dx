import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { ui: "tui" | "web" | null; help: boolean } {
  let ui: "tui" | "web" | null = "web";
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--ui") {
      const value = argv[index + 1];
      if (value === "tui" || value === "web") {
        ui = value;
        index += 1;
        continue;
      }
      return { ui: null, help: false };
    }
  }

  return { ui, help };
}

function printUsage(): void {
  console.log(`Usage: npm run digi -- --ui <tui|web>

Starts the digi-dx daemon and selected UI.

Options:
  --ui tui|web   UI to launch (default: web)
`);
}

function spawnManaged(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit"
  });
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  printUsage();
  process.exit(0);
}

if (!parsed.ui) {
  printUsage();
  process.exit(1);
}

const env = {
  ...process.env,
  DIGI_DX_CONFIG_PATH: process.env.DIGI_DX_CONFIG_PATH ?? join(repoRoot, "data/config.json"),
  PATH: prependVendorBins(process.env.PATH ?? "")
};

const daemon = spawnManaged("npx", ["tsx", "src/index.ts"], env);
const uiScript = parsed.ui === "tui" ? "ui/tui.ts" : "ui/web/server.ts";
const ui = spawnManaged("npx", ["tsx", uiScript], env);

console.info(`digi-dx: daemon + ${parsed.ui} UI starting`);
console.info(`  daemon ws://127.0.0.1:${env.DIGI_DX_PORT ?? "8788"}`);
if (parsed.ui === "web") {
  console.info(`  web   http://${env.DIGI_DX_WEB_HOST ?? "0.0.0.0"}:${env.DIGI_DX_WEB_PORT ?? "8080"}`);
}

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(`digi-dx: received ${signal}, stopping children`);
  for (const child of [ui, daemon]) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const child of [daemon, ui]) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`digi-dx: child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    shutdown("SIGTERM");
    process.exit(code ?? 1);
  });
}

function prependVendorBins(pathValue: string): string {
  // Match the arch dir the install script writes (uname -m style), not Node's
  // process.arch ("x64" / "arm64").
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const vendorBin = join(repoRoot, "vendor/engine", arch, "bin");
  return `${vendorBin}:${pathValue}`;
}
