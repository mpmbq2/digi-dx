import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { qsoLogPathFor } from "../ui/qso-log.js";
import { closeWebUiServer, startWebUiServer } from "../ui/web/server.js";
import { assertExpectedDemoQso, SmokeFailure, waitForDemoQsoEntry } from "./smoke-assert.js";
import { checkIndependenceFromGit, reportIndependenceBanner } from "./smoke-independence.js";
import { maxUsableScale } from "../core/slot-clock.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Raised enough that a full QSO finishes in seconds, still under the SlotClock floor. */
const SMOKE_SCALE = Math.min(20, Math.floor(maxUsableScale()));
const SMOKE_SEED = 7;
const DAEMON_PORT = Number(process.env.DIGI_DX_SMOKE_PORT ?? 18788);
const WEB_PORT = Number(process.env.DIGI_DX_SMOKE_WEB_PORT ?? 18080);
/** At scale 20, ~6 FT8 slots ≈ 4.5s wall; allow plenty of headroom for scheduling. */
const QSO_TIMEOUT_MS = Number(process.env.DIGI_DX_SMOKE_TIMEOUT_MS ?? 30_000);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS: ${message}`);
}

async function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ port, host }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new SmokeFailure(`daemon did not accept connections on ${host}:${port} within ${timeoutMs}ms`);
}

function spawnDaemon(env: NodeJS.ProcessEnv): ChildProcess {
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  return spawn(tsxBin, ["src/index.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // New process group so SIGTERM reaches the daemon even if tsx wrapped the node child.
    detached: true
  });
}

async function shutdownDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const pid = child.pid;
  try {
    if (pid !== undefined) {
      process.kill(-pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (pid !== undefined && child.exitCode === null) {
          process.kill(-pid, "SIGKILL");
        } else if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // Already gone.
      }
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface SmokeRunOptions {
  /** Skip TX / session bootstrap so the QSO wait times out (AE4 proof). */
  breakTx?: boolean;
  skipIndependence?: boolean;
  daemonPort?: number;
  webPort?: number;
  qsoTimeoutMs?: number;
}

export async function runSmoke(options: SmokeRunOptions = {}): Promise<void> {
  const daemonPort = options.daemonPort ?? DAEMON_PORT;
  const webPort = options.webPort ?? WEB_PORT;
  const qsoTimeoutMs = options.qsoTimeoutMs ?? QSO_TIMEOUT_MS;
  const breakTx = options.breakTx === true || process.env.DIGI_DX_SMOKE_BREAK_TX === "1";

  if (!options.skipIndependence) {
    const independence = await checkIndependenceFromGit(repoRoot);
    if (!independence.ok) {
      fail(independence.reason ?? "independence check failed");
    }
    if (independence.banner) {
      reportIndependenceBanner(independence);
    } else {
      console.log("independence: clean (no watched paths in committed range or working tree)");
    }
  }

  const demoLogPath = qsoLogPathFor("simulated");
  await mkdir(dirname(demoLogPath), { recursive: true });
  await writeFile(demoLogPath, "", "utf8");
  console.log(`demo log truncated: ${demoLogPath}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIGI_DX_ENGINE: "sim",
    DIGI_DX_SIM_SCALE: String(SMOKE_SCALE),
    DIGI_DX_SIM_SEED: String(SMOKE_SEED),
    DIGI_DX_PORT: String(daemonPort),
    DIGI_DX_CONFIG_PATH: join(repoRoot, "data", ".smoke-absent-config.json")
  };
  delete env.DIGI_DX_AUTH_TOKEN;

  const daemon = spawnDaemon(env);
  let daemonLog = "";
  daemon.stdout?.on("data", (chunk: Buffer) => {
    daemonLog += chunk.toString();
  });
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonLog += chunk.toString();
  });

  try {
    await waitForPort(daemonPort, "127.0.0.1", 15_000);
    console.log(`daemon up on :${daemonPort} (sim scale=${SMOKE_SCALE} seed=${SMOKE_SEED})`);

    if (breakTx) {
      console.log("DIGI_DX_SMOKE_BREAK_TX: skipping headless demo start (TX path deliberately broken)");
      // Still boot the web server so the wait path is real; just never start a session.
      await startWebUiServer({
        daemonUrl: `ws://127.0.0.1:${daemonPort}`,
        webPort,
        webHost: "127.0.0.1"
      });
    } else {
      await startWebUiServer({
        daemonUrl: `ws://127.0.0.1:${daemonPort}`,
        webPort,
        webHost: "127.0.0.1",
        headless: { demo: true }
      });
      console.log(`web UI headless demo live on :${webPort}`);
    }

    const entry = await waitForDemoQsoEntry(demoLogPath, { timeoutMs: qsoTimeoutMs });
    assertExpectedDemoQso(entry);
    pass(
      `QSO logged with ${entry.theirCall} (sent ${entry.sentReport}, recv ${entry.receivedReport})`
    );
  } catch (error) {
    if (daemonLog.trim()) {
      console.error("--- daemon output ---");
      console.error(daemonLog.trim());
      console.error("--- end daemon output ---");
    }
    throw error;
  } finally {
    await closeWebUiServer().catch(() => undefined);
    await shutdownDaemon(daemon);
  }
}

async function main(): Promise<void> {
  const breakTx = process.argv.includes("--break-tx");
  try {
    await runSmoke({ breakTx });
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
