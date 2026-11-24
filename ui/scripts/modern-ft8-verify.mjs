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
  for (const sysBin of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (fs.existsSync(sysBin)) return sysBin;
  }
  throw new Error("No Chromium / Google Chrome executable found");
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
  throw new Error(`Daemon at ${baseUrl} did not become healthy`);
}

function rgbMatch(str, expectedRgb) {
  return str.replace(/\s+/g, "").includes(expectedRgb.replace(/\s+/g, ""));
}

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const binPath = process.env.DIGI_DX_BIN
    ? path.resolve(process.env.DIGI_DX_BIN)
    : path.join(repoRoot, "target", "release", "digi-dx");
  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary not found at ${binPath}`);
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "digi-dx-mft8-"));
  const port = 18801;
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
  daemonProc.stdout.on("data", (d) => {
    daemonLogs += d.toString();
  });
  daemonProc.stderr.on("data", (d) => {
    daemonLogs += d.toString();
  });

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

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    await context.addInitScript(() => {
      const OrigWS = window.WebSocket;
      window.__wsCount = 0;
      window.__wsList = [];
      class TrackedWebSocket extends OrigWS {
        constructor(url, protocols) {
          super(url, protocols);
          window.__wsCount += 1;
          window.__wsList.push(this);
        }
      }
      window.WebSocket = TrackedWebSocket;
      window.__injectWsJson = (payload) => {
        const ws = window.__wsList[window.__wsList.length - 1];
        if (!ws || typeof ws.onmessage !== "function") {
          throw new Error("No active WebSocket onmessage handler");
        }
        ws.onmessage(
          new MessageEvent("message", { data: JSON.stringify(payload) })
        );
      };
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    const setLevelRequests = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/api/v1/commands")) {
        try {
          const body = req.postDataJSON();
          if (body && body.kind === "radio.set_level") {
            setLevelRequests.push(body);
          }
        } catch {
          // ignore
        }
      }
    });

    // 1. Setup Dummy Rig
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="setup-splash"]');
    await page.click('[data-testid="add-dummy-btn"]');
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid^="radio-card-"]');
      return card && card.textContent && card.textContent.includes("READY");
    });

    // Open FT8 Operation first to record baseline & verify zero CSS leakage
    await page.click('[data-testid^="open-radio-ft8-"]');
    await page.waitForSelector('[data-testid="ft8-console"]');
    const legacyShellCheck = await page.evaluate(() => {
      const shell = document.querySelector(".app-shell");
      return shell ? shell.classList.contains("app-shell--modern-ft8") : true;
    });
    assert.equal(legacyShellCheck, false);

    // 2. Switch to Modern FT8 UI tab
    await page.click('[data-testid="tab-radio-modern-ft8"]');
    await page.waitForSelector('[data-testid="modern-ft8-console"]');

    // Single shared WS check & layout fit check (no outer double scrollbars)
    const layoutMetrics = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="mft8-grid"]');
      const mainCol = document.querySelector(".mft8-main-col");
      const feedCol = document.querySelector(".mft8-feed-col");
      const loggedLane = document.querySelector('[data-testid="mft8-logged-lane"]');
      return {
        wsCount: window.__wsCount,
        scrollH: document.documentElement.scrollHeight,
        innerH: window.innerHeight,
        mainW: mainCol?.getBoundingClientRect().width ?? 0,
        feedW: feedCol?.getBoundingClientRect().width ?? 0,
        mainX: mainCol?.getBoundingClientRect().x ?? 0,
        feedX: feedCol?.getBoundingClientRect().x ?? 0,
        loggedW: loggedLane?.getBoundingClientRect().width ?? 999,
        gridExists: Boolean(grid),
      };
    });
    assert.equal(layoutMetrics.wsCount, 1, "Expected exactly 1 shared WebSocket");
    assert(
      layoutMetrics.scrollH <= layoutMetrics.innerH + 2,
      `Outer viewport overflowed (${layoutMetrics.scrollH} > ${layoutMetrics.innerH})`
    );
    assert(
      layoutMetrics.mainW > layoutMetrics.feedW * 1.4,
      `Expected ~2/3 + 1/3 split (main=${layoutMetrics.mainW}, feed=${layoutMetrics.feedW})`
    );
    assert(
      layoutMetrics.feedX > layoutMetrics.mainX,
      "Expected feed on right initially"
    );
    assert(
      layoutMetrics.loggedW <= 135,
      `Expected ultra-minimal LOGGED bay <= 135px, got ${layoutMetrics.loggedW}`
    );

    // Flip Feed toggle + localStorage persistence
    await page.click('[data-testid="mft8-flip-feed"]');
    await page.waitForFunction(() => {
      const mainX = document.querySelector(".mft8-main-col")?.getBoundingClientRect().x ?? 0;
      const feedX = document.querySelector(".mft8-feed-col")?.getBoundingClientRect().x ?? 0;
      return feedX < mainX;
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="modern-ft8-console"]');
    const persistedLeft = await page.evaluate(() => {
      const mainX = document.querySelector(".mft8-main-col")?.getBoundingClientRect().x ?? 0;
      const feedX = document.querySelector(".mft8-feed-col")?.getBoundingClientRect().x ?? 0;
      return feedX < mainX;
    });
    assert.equal(persistedLeft, true, "Flip Feed state did not persist in localStorage");
    await page.click('[data-testid="mft8-flip-feed"]');

    // Tab round-trip check (Modern <-> Legacy FT8 <-> Modern) preserves single WS & zero CSS leakage
    await page.click('[data-testid="tab-radio-ft8"]');
    await page.waitForSelector('[data-testid="ft8-console"]');
    const afterSwitchLegacy = await page.evaluate(() => ({
      wsCount: window.__wsCount,
      hasModernClass: document
        .querySelector(".app-shell")
        ?.classList.contains("app-shell--modern-ft8"),
      hasModernRoot: Boolean(document.querySelector(".modern-ft8-root")),
    }));
    assert.equal(afterSwitchLegacy.wsCount, 1);
    assert.equal(afterSwitchLegacy.hasModernClass, false);
    assert.equal(afterSwitchLegacy.hasModernRoot, false);

    await page.click('[data-testid="tab-radio-modern-ft8"]');
    await page.waitForSelector('[data-testid="modern-ft8-console"]');
    assert.equal(await page.evaluate(() => window.__wsCount), 1);

    // 3. Band Switcher & Mode Toggle (FT8 <-> FT4)
    await page.selectOption('[data-testid="mft8-band-select"]', "20m");
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mft8-dial-freq"]');
      return el && el.textContent && el.textContent.includes("14.074000");
    });

    await page.click('[data-testid="mft8-mode-ft4"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mft8-dial-freq"]');
      const cd = document.querySelector('[data-testid="mft8-countdown"]');
      const sec = cd ? parseFloat(cd.textContent || "99") : 99;
      return el && el.textContent && el.textContent.includes("14.080000") && sec <= 7.5;
    });

    await page.selectOption('[data-testid="mft8-band-select"]', "40m");
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mft8-dial-freq"]');
      return el && el.textContent && el.textContent.includes("7.047500");
    });

    await page.click('[data-testid="mft8-mode-ft8"]');
    await page.selectOption('[data-testid="mft8-band-select"]', "20m");
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="mft8-dial-freq"]');
      return el && el.textContent && el.textContent.includes("14.074000");
    });

    // 4. TX Power Drag Debounce: dragging across 8 steps must emit ONLY ONE radio.set_level
    setLevelRequests.length = 0;
    const sliderBox = await page
      .locator('[data-testid="mft8-power-slider"]')
      .boundingBox();
    assert(sliderBox, "TX Power slider missing bounding box");
    const yMid = sliderBox.y + sliderBox.height / 2;
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.25, yMid);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        sliderBox.x + sliderBox.width * (0.25 + step * 0.07),
        yMid
      );
      await page.waitForTimeout(20);
    }
    assert.equal(
      setLevelRequests.length,
      0,
      `Expected 0 CAT level writes while dragging, got ${setLevelRequests.length}`
    );
    await page.mouse.up();
    await page.waitForTimeout(450);
    assert.equal(
      setLevelRequests.length,
      1,
      `Expected strictly 1 CAT level write after release, got ${setLevelRequests.length}`
    );

    // 5. Momentary TUNE toggle ON -> OFF
    await page.click('[data-testid="mft8-tune-btn"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="mft8-tune-btn"]');
      return btn && btn.textContent && btn.textContent.includes("TUNING");
    });
    await page.click('[data-testid="mft8-tune-btn"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="mft8-tune-btn"]');
      return btn && btn.textContent && !btn.textContent.includes("TUNING");
    });

    // 6. Start 20x Demo Session and wait for Roster + Live Batch Feed + Waterfall
    await page.click('[data-testid="mft8-demo-toggle"]');
    await page.selectOption('[data-testid="mft8-demo-scale"]', "20");
    await page.click('[data-testid="mft8-start-demo"]');
    await page.waitForSelector('[data-testid="demo-banner"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="mft8-roster-row"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="mft8-feed-row"]', { timeout: 10000 });

    // Confirm real waterfall frames rendered onto canvas (non-zero non-background pixels)
    const hasWfSignal = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="mft8-waterfall-canvas"]');
      if (!c) return false;
      const ctx = c.getContext("2d");
      const data = ctx.getImageData(0, 0, c.width, Math.min(20, c.height)).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 18 || data[i + 1] > 40 || data[i + 2] > 60) return true;
      }
      return false;
    });
    assert.equal(hasWfSignal, true, "Expected live FFT pixels rendered on waterfall canvas");

    // 7. Create Q1, then pause TX during Targeting-Others & Hover checks so Q1 stays active cleanly
    await page.click('[data-testid="mft8-roster-call-btn"]');
    await page.waitForSelector('[data-testid="mft8-qso-strip"]', { timeout: 5000 });
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="mft8-tx-toggle"]');
      return btn && btn.textContent && btn.textContent.includes("TX ARMED");
    });
    await page.click('[data-testid="mft8-tx-toggle"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="mft8-tx-toggle"]');
      return btn && btn.textContent && btn.textContent.includes("ENABLE TX");
    });

    const activeQInfo = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="mft8-qso-strip"]');
      if (!strip) return null;
      return {
        callsign: strip.getAttribute("data-callsign"),
        hz: Number(strip.getAttribute("data-hz") || 1420),
        color: strip.getAttribute("data-color"),
        pill: strip.querySelector(".mft8-q-pill")?.textContent?.trim(),
      };
    });
    assert(activeQInfo && activeQInfo.callsign && activeQInfo.color, "Missing active QSO info");

    // Inject a decode where the active QSO station answers another station -> must land in Targeting Others AND keep Q1 accent color!
    const latestTs = await page.evaluate(() => {
      const blk = document.querySelector('[data-testid="mft8-cycle-block"]');
      const raw = blk?.getAttribute("data-ts-sec");
      return raw ? Number(raw) : Math.floor(Date.now() / 1000);
    });
    await page.evaluate(
      ({ call, hz, ts }) => {
        window.__injectWsJson({
          type: "decode",
          radio_id: "sim",
          ts_sec: ts,
          slot: "even",
          snr_db: -9,
          dt_sec: 0.1,
          af_hz: hz,
          mode: "FT8",
          message: `QQ9OTH ${call} -09`,
          decoder_backend: "simulated",
        });
      },
      { call: activeQInfo.callsign, hz: activeQInfo.hz, ts: latestTs }
    );

    await page.waitForFunction(
      (call) => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid="mft8-feed-row"][data-section="others"]')
        );
        return rows.some(
          (r) =>
            r.textContent?.includes(`QQ9OTH ${call} -09`) &&
            r.querySelector('[data-testid="mft8-feed-qso-pill"]')?.textContent?.trim() === "Q1"
        );
      },
      activeQInfo.callsign,
      { timeout: 5000 }
    );

    const othersColorCheck = await page.evaluate((call) => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="mft8-feed-row"][data-section="others"]')
      );
      const row = rows.find((r) => r.textContent?.includes(`QQ9OTH ${call} -09`));
      return row ? getComputedStyle(row).borderLeftColor : null;
    }, activeQInfo.callsign);
    assert(
      rgbMatch(othersColorCheck || "", "rgb(56,189,248)"),
      `Expected Q1 Cyan border color in Targeting Others, got ${othersColorCheck}`
    );

    // 8. Global Cross-Highlighting + Hover Beam + Zero Layout Shift
    const beforeBoxes = await page.evaluate((call) => {
      const strip = document.querySelector(
        `[data-testid="mft8-qso-strip"][data-callsign="${call}"]`
      );
      const rosterRow = document.querySelector(
        `[data-testid="mft8-roster-row"][data-callsign="${call}"]`
      );
      const feedRow = document.querySelector(
        `[data-testid="mft8-feed-row"][data-callsign="${call}"]`
      );
      const ov = document.querySelector('[data-testid="mft8-waterfall-overlay"]');
      const ovCtx = ov.getContext("2d");
      const ovPx = ovCtx.getImageData(0, 0, ov.width, ov.height).data;
      let nonZeroBefore = 0;
      for (let i = 3; i < ovPx.length; i += 4) if (ovPx[i] > 0) nonZeroBefore++;
      return {
        strip: strip?.getBoundingClientRect().toJSON() ?? null,
        roster: rosterRow?.getBoundingClientRect().toJSON() ?? null,
        feed: feedRow?.getBoundingClientRect().toJSON() ?? null,
        nonZeroBefore,
      };
    }, activeQInfo.callsign);

    assert(beforeBoxes.strip && beforeBoxes.roster && beforeBoxes.feed);

    await page
      .locator(`[data-testid="mft8-feed-row"][data-callsign="${activeQInfo.callsign}"]`)
      .first()
      .hover();
    await page.waitForTimeout(80);

    const afterHover = await page.evaluate((call) => {
      const strip = document.querySelector(
        `[data-testid="mft8-qso-strip"][data-callsign="${call}"]`
      );
      const rosterRow = document.querySelector(
        `[data-testid="mft8-roster-row"][data-callsign="${call}"]`
      );
      const feedRow = document.querySelector(
        `[data-testid="mft8-feed-row"][data-callsign="${call}"]`
      );
      const ov = document.querySelector('[data-testid="mft8-waterfall-overlay"]');
      const ovCtx = ov.getContext("2d");
      const ovPx = ovCtx.getImageData(0, 0, ov.width, ov.height).data;
      let nonZeroAfter = 0;
      for (let i = 3; i < ovPx.length; i += 4) if (ovPx[i] > 0) nonZeroAfter++;
      return {
        stripHovered: strip?.classList.contains("mft8-sync-hover") ?? false,
        rosterHovered: rosterRow?.classList.contains("mft8-sync-hover") ?? false,
        feedHovered: feedRow?.classList.contains("mft8-sync-hover") ?? false,
        stripBox: strip?.getBoundingClientRect().toJSON() ?? null,
        rosterBox: rosterRow?.getBoundingClientRect().toJSON() ?? null,
        feedBox: feedRow?.getBoundingClientRect().toJSON() ?? null,
        nonZeroAfter,
      };
    }, activeQInfo.callsign);

    assert.equal(afterHover.stripHovered, true, "Swimlane strip did not cross-highlight");
    assert.equal(afterHover.rosterHovered, true, "Roster row did not cross-highlight");
    assert.equal(afterHover.feedHovered, true, "Feed row did not cross-highlight");
    assert(
      afterHover.nonZeroAfter > beforeBoxes.nonZeroBefore + 50,
      `Expected Hover Beam pixels on waterfall overlay (before=${beforeBoxes.nonZeroBefore}, after=${afterHover.nonZeroAfter})`
    );
    for (const key of ["strip", "roster", "feed"]) {
      const b0 = beforeBoxes[key];
      const b1 = afterHover[`${key}Box`];
      assert(Math.abs(b0.x - b1.x) < 0.5 && Math.abs(b0.y - b1.y) < 0.5, `${key} shifted position`);
      assert(
        Math.abs(b0.width - b1.width) < 0.5 && Math.abs(b0.height - b1.height) < 0.5,
        `${key} changed size`
      );
    }

    // 9. Resume TX so Q1 completes naturally, enters minimal grey LOGGED bay (2 cyc -> 1 cyc),
    //    and auto-archives after 2 subsequent cycles into collapsed "Logged This Session (N)" drawer
    await page.click('[data-testid="mft8-tx-toggle"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="mft8-tx-toggle"]');
      return btn && btn.textContent && btn.textContent.includes("TX ARMED");
    });
    await page.waitForSelector('[data-testid="mft8-logged-chip"]', { timeout: 15000 });

    const loggedStyle = await page.evaluate(() => {
      const chip = document.querySelector('[data-testid="mft8-logged-chip"]');
      const cyc = chip?.querySelector('[data-testid="mft8-logged-cyc"]')?.textContent?.trim();
      const drawerBtn = document.querySelector('[data-testid="mft8-session-drawer-toggle"]');
      return {
        filter: chip ? getComputedStyle(chip).filter : "",
        cyc,
        expanded: drawerBtn?.getAttribute("aria-expanded"),
      };
    });
    assert(loggedStyle.filter.includes("grayscale"), `Expected desaturated LOGGED chip, got ${loggedStyle.filter}`);
    assert.match(loggedStyle.cyc ?? "", /^(1|2) cyc$/);
    assert.equal(loggedStyle.expanded, "false", "Session drawer must be collapsed by default");

    // Wait for 2 subsequent FT8 cycles at 20x (~1.5s) for auto-archive into drawer
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll('[data-testid="mft8-logged-chip"]');
      const lbl = document.querySelector('[data-testid="mft8-session-drawer-label"]')?.textContent ?? "";
      return chips.length === 0 && lbl.includes("Logged This Session (1)");
    }, { timeout: 8000 });

    // Expand drawer and verify archived row + QRZ link
    await page.click('[data-testid="mft8-session-drawer-toggle"]');
    await page.waitForSelector('[data-testid="mft8-archived-row"]', { timeout: 3000 });

    // Stop demo session cleanly
    await page.click('[data-testid="mft8-stop-session"]');
    await page.waitForSelector('[data-testid="demo-banner"]', {
      state: "detached",
      timeout: 10000,
    });

    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join("; ")}`);
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join("; ")}`);
    console.log("MODERN_FT8_VERIFY_OK");
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
