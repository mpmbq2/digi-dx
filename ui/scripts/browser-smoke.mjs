import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

function findBrowserExecutable() {
  const pwRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pwRoot)) {
    const entries = fs.readdirSync(pwRoot).sort().reverse();
    for (const dir of entries) {
      const candidates = [
        path.join(pwRoot, dir, "chrome-linux", "chrome"),
        path.join(pwRoot, dir, "chrome-linux", "headless_shell"),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }
  for (const sysBin of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (fs.existsSync(sysBin)) return sysBin;
  }
  throw new Error("No Chromium / Google Chrome executable found for Playwright smoke test");
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Daemon at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const binPath = path.join(repoRoot, "target", "release", "digi-dx");
  if (!fs.existsSync(binPath)) {
    throw new Error(`Release binary not found at ${binPath}; run 'make build' first`);
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "digi-dx-pw-"));
  const port = 18799;
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemonProc = spawn(
    binPath,
    ["serve", "--bind", "127.0.0.1", "--port", String(port), "--data-dir", tmpData],
    {
      cwd: os.tmpdir(),
      env: { ...process.env, DIGI_DX_DATA_DIR: tmpData },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let daemonLogs = "";
  daemonProc.stdout.on("data", (d) => { daemonLogs += d.toString(); });
  daemonProc.stderr.on("data", (d) => { daemonLogs += d.toString(); });

  let browser;
  try {
    const health = await waitForHealth(baseUrl);
    assert.equal(health.status, "ok");

    const executablePath = findBrowserExecutable();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="slot-countdown"]');
    const countdownText = await page.textContent('[data-testid="slot-countdown"]');
    assert.match(countdownText ?? "", /Next slot in \d+\.\ds/);

    // Start fast 20x Demo Session
    await page.selectOption('[data-testid="demo-scale-select"]', "20");
    await page.click('[data-testid="start-demo-btn"]');
    await page.waitForSelector('[data-testid="demo-banner"]', { timeout: 10000 });
    const bannerText = await page.textContent('[data-testid="demo-banner"]');
    assert.match(bannerText ?? "", /DEMO MODE ACTIVE/);

    // Verify AF Picker input + waterfall click interaction
    await page.fill('[data-testid="af-input"]', "1620");
    await page.click('[data-testid="set-af-btn"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="active-af-badge"]');
      return el && el.textContent && el.textContent.includes("1620 Hz");
    });

    const box = await page.locator('[data-testid="waterfall-canvas"]').boundingBox();
    assert(box && box.width > 100, "waterfall canvas missing bounding box");
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="active-af-badge"]');
      return el && el.textContent && !el.textContent.includes("1620 Hz");
    });

    // Trigger Call CQ and wait for simulated QSO completion in Demo Log
    await page.click('[data-testid="call-cq-btn"]');
    await page.click('[data-testid="nav-logbook"]');
    await page.click('[data-testid="tab-demo-log"]');
    await page.waitForSelector('[data-testid="demo-qso-row"]', { timeout: 15000 });
    const demoRowText = await page.textContent('[data-testid="demo-qso-row"]');
    assert.match(demoRowText ?? "", /QQ0DEMO/);
    assert.match(demoRowText ?? "", /QQ\d/);

    // Confirm ADIF export strictly excludes demo QSOs
    const adifRes = await fetch(`${baseUrl}/api/v1/qsos/export.adi`);
    assert.equal(adifRes.status, 200);
    const adifText = await adifRes.text();
    assert(adifText.includes("<EOH>"), "ADIF header missing");
    assert(!adifText.includes("<EOR>"), "Demo QSO leaked into ADIF export");
    assert(!adifText.includes("QQ"), "QQ callsign leaked into ADIF export");

    // Stop demo session cleanly
    await page.click('[data-testid="nav-operate"]');
    await page.click('[data-testid="stop-session-btn"]');
    await page.waitForSelector('[data-testid="demo-banner"]', { state: "detached", timeout: 10000 });

    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join("; ")}`);
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join("; ")}`);
    console.log("PLAYWRIGHT_SMOKE_OK", { countdownText, demoRowText: demoRowText?.trim() });
  } finally {
    if (browser) await browser.close();
    if (daemonProc.exitCode === null) {
      daemonProc.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          daemonProc.kill("SIGKILL");
          resolve();
        }, 5000);
        daemonProc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    fs.rmSync(tmpData, { recursive: true, force: true });
    if (daemonProc.exitCode !== 0 && daemonProc.exitCode !== null) {
      console.error("Daemon logs:\n", daemonLogs);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
