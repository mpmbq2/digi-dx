import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

function findBrowserExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const pwRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pwRoot)) {
    const entries = fs.readdirSync(pwRoot).sort().reverse();
    for (const dir of entries) {
      const candidates = [
        path.join(pwRoot, dir, "chrome-linux", "chrome"),
        path.join(pwRoot, dir, "chrome-linux64", "chrome"),
        path.join(pwRoot, dir, "chrome-linux", "headless_shell"),
        path.join(pwRoot, dir, "chrome-linux64", "headless_shell"),
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
  const binPath = process.env.DIGI_DX_BIN
    ? path.resolve(process.env.DIGI_DX_BIN)
    : path.join(repoRoot, "target", "release", "digi-dx");
  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary not found at ${binPath}; run 'make build' (or set DIGI_DX_BIN)`);
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

    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Lands on Hardware & Setup splash screen
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="setup-splash"]');

    // 2. Add Dummy Rig (-m 1), wait for READY, and click into Tab 1 (Radio Info & Controls)
    await page.click('[data-testid="add-dummy-btn"]');
    await page.waitForSelector('[data-testid^="open-radio-info-"]', { timeout: 10000 });
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid^="radio-card-"]');
      return card && card.textContent && card.textContent.includes("READY");
    }, { timeout: 10000 });

    await page.click('[data-testid^="open-radio-info-"]');
    await page.waitForSelector('[data-testid="radio-info-panel"]');

    // Verify dynamic Hamlib controls rendered and toggle TUNER
    await page.waitForSelector('[data-testid="func-toggle-TUNER"]', { timeout: 10000 });
    await page.click('[data-testid="func-toggle-TUNER"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="func-toggle-TUNER"]');
      return btn && btn.textContent && btn.textContent.includes("ON");
    }, { timeout: 5000 });

    // 3. Switch to Tab 2: FT8 Operation and verify 2/3 Waterfall + 1/3 Live Decodes layout
    await page.click('[data-testid="tab-radio-ft8"]');
    await page.waitForSelector('[data-testid="slot-countdown"]');
    await page.waitForSelector('[data-testid="channel-roster-panel"]');

    const wfBox = await page.locator('[data-testid="waterfall-canvas"]').boundingBox();
    const decBox = await page.locator('[data-testid="live-decodes-panel"]').boundingBox();
    assert(wfBox && decBox, "waterfall or live decodes missing bounding box");
    assert(wfBox.width > decBox.width, `expected waterfall (${wfBox.width}) wider than decodes (${decBox.width})`);

    // Tune Dummy Rig to 20m (14.074 MHz) before starting 20x Demo Session
    await page.selectOption('[data-testid="ft8-band-select"]', "14074000");
    await page.waitForFunction(() => {
      const lbl = document.querySelector('[data-testid="roster-channel-label"]');
      return lbl && lbl.textContent && lbl.textContent.includes("14074000");
    }, { timeout: 5000 });

    // 4. Open Demo Mode popover and start 20x Demo Session
    await page.click('[data-testid="demo-menu-toggle"]');
    await page.selectOption('[data-testid="demo-scale-select"]', "20");
    await page.click('[data-testid="start-demo-btn"]');
    await page.waitForSelector('[data-testid="demo-banner"]', { timeout: 10000 });
    const bannerText = await page.textContent('[data-testid="demo-banner"]');
    assert.match(bannerText ?? "", /DEMO MODE ACTIVE/);

    // 5. Verify AF input + waterfall click interaction
    await page.fill('[data-testid="af-input"]', "1620");
    await page.click('[data-testid="set-af-btn"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="active-af-badge"]');
      return el && el.textContent && el.textContent.includes("1620 Hz");
    });

    await page.mouse.click(wfBox.x + wfBox.width * 0.4, wfBox.y + wfBox.height * 0.5);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="active-af-badge"]');
      return el && el.textContent && !el.textContent.includes("1620 Hz");
    });

    // 6. Verify Channel Roster populates with QQ* stations from SQLite, role badges, QRZ link, mi/km toggle & sorting
    //    and confirm Live Decodes inserts cycle dividers across multiple 15s cycles
    await page.waitForSelector('[data-testid="roster-row"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="decode-cycle-divider"]', { timeout: 10000 });
    const roleText = await page.textContent('[data-testid="roster-role-badge"]');
    assert.match(roleText ?? "", /^(CALLER|HUNTER)$/);
    const qrzHref = await page.getAttribute('[data-testid="roster-qrz-link"]', "href");
    const qrzTarget = await page.getAttribute('[data-testid="roster-qrz-link"]', "target");
    assert.match(qrzHref ?? "", /^https:\/\/www\.qrz\.com\/db\/QQ/);
    assert.equal(qrzTarget, "_blank");

    const unitBefore = await page.textContent('[data-testid="roster-unit-toggle"]');
    assert.match(unitBefore ?? "", /mi/);
    await page.click('[data-testid="roster-unit-toggle"]');
    const unitAfter = await page.textContent('[data-testid="roster-unit-toggle"]');
    assert.match(unitAfter ?? "", /km/);
    await page.click('[data-testid="roster-sort-role"]');
    await page.click('[data-testid="roster-sort-grid"]');
    await page.click('[data-testid="roster-sort-distance"]');
    await page.click('[data-testid="roster-sort-snr"]');

    // 7. Verify SQLite channel switching: QSY to 40m -> empty roster -> QSY back to 20m -> 20m rows return
    await page.selectOption('[data-testid="ft8-band-select"]', "7074000");
    await page.waitForFunction(() => {
      const lbl = document.querySelector('[data-testid="roster-channel-label"]');
      const rows = document.querySelectorAll('[data-testid="roster-row"]');
      return lbl && lbl.textContent && lbl.textContent.includes("7074000") && rows.length === 0;
    }, { timeout: 5000 });

    await page.selectOption('[data-testid="ft8-band-select"]', "14074000");
    await page.waitForFunction(() => {
      const lbl = document.querySelector('[data-testid="roster-channel-label"]');
      const rows = document.querySelectorAll('[data-testid="roster-row"]');
      return lbl && lbl.textContent && lbl.textContent.includes("14074000") && rows.length > 0;
    }, { timeout: 5000 });

    // 8. Pause TX temporarily while inspecting QSO Sequencer card fields, then Reply, verify RX/TX boxes & QRZ link,
    //    resume TX and wait for full Hunter QSO completion in Demo Log
    await page.click('[data-testid="tx-enable-toggle"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="tx-enable-toggle"]');
      return btn && btn.textContent && btn.textContent.includes("MUTED");
    }, { timeout: 5000 });

    await page.click('[data-testid="roster-row"] button');
    await page.waitForSelector('[data-testid="qso-card"]', { timeout: 5000 });

    const qsoLastRx = await page.textContent('[data-testid="qso-last-rx-msg"]');
    assert.match(qsoLastRx ?? "", /CQ QQ/);

    const qsoTxMsg = await page.textContent('[data-testid="qso-tx-msg"]');
    assert.match(qsoTxMsg ?? "", /^QQ\d[A-Z]+ QQ0DEMO /);
    assert(!qsoTxMsg?.includes("Hz"), `TX message mixed AF into message string: ${qsoTxMsg}`);

    const qsoTxAf = await page.textContent('[data-testid="qso-tx-af"]');
    assert.match(qsoTxAf ?? "", /^AF \d+ Hz$/);

    const qsoQrzHref = await page.getAttribute('[data-testid="qso-qrz-link"]', "href");
    const qsoQrzTarget = await page.getAttribute('[data-testid="qso-qrz-link"]', "target");
    assert.match(qsoQrzHref ?? "", /^https:\/\/www\.qrz\.com\/db\/QQ/);
    assert.equal(qsoQrzTarget, "_blank");

    await page.click('[data-testid="tx-enable-toggle"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="tx-enable-toggle"]');
      return btn && btn.textContent && btn.textContent.includes("ENABLED");
    }, { timeout: 5000 });

    await page.click('[data-testid="call-cq-btn"]');
    await page.click('[data-testid="nav-logbook"]');
    await page.click('[data-testid="tab-demo-log"]');
    await page.waitForSelector('[data-testid="demo-qso-row"]', { timeout: 15000 });
    const demoRowText = await page.textContent('[data-testid="demo-qso-row"]');
    assert.match(demoRowText ?? "", /QQ0DEMO/);
    assert.match(demoRowText ?? "", /QQ\d/);

    // 9. Confirm ADIF export strictly excludes demo QSOs
    const adifRes = await fetch(`${baseUrl}/api/v1/qsos/export.adi`);
    assert.equal(adifRes.status, 200);
    const adifText = await adifRes.text();
    assert(adifText.includes("<EOH>"), "ADIF header missing");
    assert(!adifText.includes("<EOR>"), "Demo QSO leaked into ADIF export");
    assert(!adifText.includes("QQ"), "QQ callsign leaked into ADIF export");

    // 10. Return to FT8 Operation and stop demo session cleanly
    await page.click('[data-testid="nav-setup"]');
    await page.click('[data-testid^="open-radio-ft8-"]');
    await page.click('[data-testid="stop-session-btn"]');
    await page.waitForSelector('[data-testid="demo-banner"]', { state: "detached", timeout: 10000 });

    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join("; ")}`);
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join("; ")}`);
    console.log("PLAYWRIGHT_SMOKE_OK", { demoRowText: demoRowText?.trim() });
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
