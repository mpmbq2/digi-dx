/**
 * U9 — drive the web client against DIGI_DX_ENGINE=sim in a headless browser,
 * capture phone-legible screenshots (decode list + completed QSO), and assert
 * the rendered countdown agrees with the published slot clock (AE1).
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install chromium
 *
 * Run:
 *   npm run smoke:ui
 *
 * Screenshots land under artifacts/smoke-ui/ (gitignored). Paths are printed
 * on PASS so a PR body can link them.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { chromium, type Page } from "playwright";
import { maxUsableScale } from "../core/slot-clock.js";
import { qsoLogPathFor } from "../ui/qso-log.js";
import { closeWebUiServer, startWebUiServer } from "../ui/web/server.js";
import { assertExpectedDemoQso, SmokeFailure, waitForDemoQsoEntry } from "./smoke-assert.js";
import { checkIndependenceFromGit, reportIndependenceBanner } from "./smoke-independence.js";
import {
  assertCountdownAgrees,
  type PublishedCycle
} from "./smoke-ui-countdown.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Raised enough that a full QSO finishes in seconds, still under the SlotClock floor. */
const SMOKE_SCALE = Math.min(20, Math.floor(maxUsableScale()));
const SMOKE_SEED = 7;
/** Distinct from `npm run smoke` defaults so both can run without colliding. */
const DAEMON_PORT = Number(process.env.DIGI_DX_SMOKE_UI_DAEMON_PORT ?? 18789);
const WEB_PORT = Number(process.env.DIGI_DX_SMOKE_UI_WEB_PORT ?? 18081);
const QSO_TIMEOUT_MS = Number(process.env.DIGI_DX_SMOKE_UI_TIMEOUT_MS ?? 45_000);

/** Phone-legible viewport so R14 satisfies R16 by construction. */
const VIEWPORT = { width: 390, height: 844 } as const;

const ARTIFACT_DIR = join(repoRoot, "artifacts", "smoke-ui");
const DECODE_SHOT = join(ARTIFACT_DIR, "decodes.png");
const COMPLETE_SHOT = join(ARTIFACT_DIR, "qso-complete.png");

interface UiStateMessage {
  type: "state";
  serverNow: number;
  cycle: PublishedCycle;
  station: { demo?: boolean; sessionActive?: boolean };
  decodes: unknown[];
  qsos: { completed: unknown[] };
}

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

function trackLatestState(page: Page): { latest: () => UiStateMessage | null } {
  let latest: UiStateMessage | null = null;
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws")) {
      return;
    }
    ws.on("framereceived", (event) => {
      try {
        const payload =
          typeof event.payload === "string" ? event.payload : event.payload.toString();
        const message = JSON.parse(payload) as UiStateMessage;
        if (message?.type === "state") {
          latest = message;
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
  });
  return {
    latest: () => latest
  };
}

async function waitForState(
  getLatest: () => UiStateMessage | null,
  predicate: (state: UiStateMessage) => boolean,
  timeoutMs: number,
  label: string
): Promise<UiStateMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getLatest();
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SmokeFailure(`smoke-ui failed: timed out waiting for ${label} within ${timeoutMs}ms`);
}

async function assertDemoBannerVisible(page: Page): Promise<void> {
  const banner = page.locator("#demo-banner");
  await banner.waitFor({ state: "visible", timeout: 10_000 });
  const text = (await banner.textContent()) ?? "";
  if (!/DEMO MODE/i.test(text)) {
    throw new SmokeFailure(`smoke-ui failed: demo banner text unexpected: ${JSON.stringify(text)}`);
  }
}

/**
 * AE1: right after a state frame, the DOM countdown must match the published
 * wall deadline recomputed in the page at the capture instant.
 */
async function assertCountdownAtCapture(page: Page, cycle: PublishedCycle): Promise<void> {
  if (cycle.nextBoundaryWallMs === null || !cycle.slotWallMs || cycle.slotSeconds === null) {
    throw new SmokeFailure("smoke-ui failed: no published cycle deadline at capture");
  }

  const result = await page.evaluate((published) => {
    const nowMs = Date.now();
    const text = document.getElementById("cycle-value")?.textContent?.trim() ?? "";
    const remainingWallMs = Math.max(0, published.nextBoundaryWallMs! - nowMs);
    const expected = (remainingWallMs / published.slotWallMs!) * published.slotSeconds!;
    return { text, nowMs, expected };
  }, cycle);

  // Browser ticks every 200ms; at scale 20 that is ~4 FT8-seconds of drift, so
  // allow the refresh window plus one decimal place of rounding.
  const tickToleranceFt8 =
    cycle.slotWallMs > 0 ? (220 / cycle.slotWallMs) * (cycle.slotSeconds ?? 15) + 0.15 : 0.5;

  assertCountdownAgrees(result.text, cycle, {
    nowMs: result.nowMs,
    toleranceFt8Seconds: tickToleranceFt8
  });
  pass(
    `countdown agrees with published clock (${result.text}; Δ≤${tickToleranceFt8.toFixed(2)}s FT8)`
  );
}

export interface SmokeUiRunOptions {
  skipIndependence?: boolean;
  daemonPort?: number;
  webPort?: number;
  qsoTimeoutMs?: number;
}

export async function runSmokeUi(options: SmokeUiRunOptions = {}): Promise<void> {
  const daemonPort = options.daemonPort ?? DAEMON_PORT;
  const webPort = options.webPort ?? WEB_PORT;
  const qsoTimeoutMs = options.qsoTimeoutMs ?? QSO_TIMEOUT_MS;

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
  await mkdir(ARTIFACT_DIR, { recursive: true });
  console.log(`demo log truncated: ${demoLogPath}`);
  console.log(`screenshots → ${ARTIFACT_DIR}`);

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

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    await waitForPort(daemonPort, "127.0.0.1", 15_000);
    console.log(`daemon up on :${daemonPort} (sim scale=${SMOKE_SCALE} seed=${SMOKE_SEED})`);

    // No headless.demo — the browser clicks "Try it without a radio" (R19).
    await startWebUiServer({
      daemonUrl: `ws://127.0.0.1:${daemonPort}`,
      webPort,
      webHost: "127.0.0.1"
    });
    console.log(`web UI on :${webPort} (awaiting browser demo start)`);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    const stateTracker = trackLatestState(page);

    await page.goto(`http://127.0.0.1:${webPort}/`, { waitUntil: "domcontentloaded" });

    const demoButton = page.locator("button.setup-demo");
    await demoButton.waitFor({ state: "visible", timeout: 15_000 });
    await demoButton.click();
    console.log('clicked "Try it without a radio"');

    await waitForState(
      stateTracker.latest,
      (s) => Boolean(s.station?.demo) && Boolean(s.station?.sessionActive),
      15_000,
      "demo session"
    );
    await assertDemoBannerVisible(page);

    await waitForState(
      stateTracker.latest,
      (s) => Array.isArray(s.decodes) && s.decodes.length > 0,
      qsoTimeoutMs,
      "populated decode list"
    );
    await assertDemoBannerVisible(page);
    const decodeState = stateTracker.latest();
    if (!decodeState) {
      throw new SmokeFailure("smoke-ui failed: lost UI state before decode screenshot");
    }
    await assertCountdownAtCapture(page, decodeState.cycle);
    await page.screenshot({ path: DECODE_SHOT, fullPage: true });
    pass(`decode list screenshot → ${DECODE_SHOT}`);

    await waitForState(
      stateTracker.latest,
      (s) => Array.isArray(s.qsos?.completed) && s.qsos.completed.length > 0,
      qsoTimeoutMs,
      "completed QSO in UI"
    );
    // Also require the demo log — same outcome gate as U8, fail-closed if UI lies.
    const entry = await waitForDemoQsoEntry(demoLogPath, { timeoutMs: Math.min(5_000, qsoTimeoutMs) });
    assertExpectedDemoQso(entry);

    await assertDemoBannerVisible(page);
    const completeState = stateTracker.latest();
    if (!completeState) {
      throw new SmokeFailure("smoke-ui failed: lost UI state before completed-QSO screenshot");
    }
    await assertCountdownAtCapture(page, completeState.cycle);

    // Bring completed panel into view on the phone viewport before capture.
    await page.locator("#completed-list").scrollIntoViewIfNeeded();
    await page.screenshot({ path: COMPLETE_SHOT, fullPage: true });
    pass(`completed QSO screenshot → ${COMPLETE_SHOT}`);
    pass(
      `QSO completed with ${entry.theirCall} (sent ${entry.sentReport}, recv ${entry.receivedReport})`
    );
  } catch (error) {
    if (daemonLog.trim()) {
      console.error("--- daemon output ---");
      console.error(daemonLog.trim());
      console.error("--- end daemon output ---");
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await closeWebUiServer().catch(() => undefined);
    await shutdownDaemon(daemon);
  }
}

async function main(): Promise<void> {
  try {
    await runSmokeUi();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
