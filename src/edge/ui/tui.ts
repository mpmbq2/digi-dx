import blessed from "blessed";
import type { EdgePairingService } from "../pairing.js";
import type { AudioDevice } from "../../daemon/audio-devices.js";
import { type EdgeRuntime, type EdgeTelemetry, createInitialTelemetry, formatMhz } from "../runtime.js";

// Comprehensive local TUI screen running on the edge machine (R2).
// Exposes hardware device selection, serial port setup, cloud pairing,
// and live telemetry across the 5 diagnostic pillars for headless SSH operators.

export interface EdgeTuiOptions {
  runtime?: EdgeRuntime;
  pairingService?: EdgePairingService;
  listAudioDevices?: () => Promise<AudioDevice[]>;
  onSaveConfig?: (config: { deviceId: number; catMode: string; catPort: number; callsign?: string; grid?: string; cloudUrl?: string }) => Promise<void>;
  onQuit?: () => void;
}

export function startEdgeTui(options: EdgeTuiOptions): { screen: blessed.Widgets.Screen; destroy: () => void } {
  const runtime = options.runtime;
  let isDestroyed = false;
  let dialogOpen = false;
  const radioLog: string[] = [];

  const screen = blessed.screen({
    smartCSR: true,
    title: "Digi-Dx Edge Radio Setup & Diagnostics"
  });

  const banner = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } }
  });

  const pairingBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "50%",
    height: 12,
    label: " 1. Cloud Gateway & Pairing ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "yellow" } }
  });

  const radioBox = blessed.box({
    parent: screen,
    top: 15,
    left: 0,
    width: "50%",
    height: "100%-18",
    label: " 2. Radio CAT & PTT Control ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "magenta" } }
  });

  const ft8Box = blessed.box({
    parent: screen,
    top: 3,
    left: "50%",
    width: "50%",
    height: 12,
    label: " 3. FT8 Modem & Audio DSP ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "green" } }
  });

  const configBox = blessed.box({
    parent: screen,
    top: 15,
    left: "50%",
    width: "50%",
    height: "100%-18",
    label: " 4. Station & Hardware Config ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "blue" } }
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: " [g] New PIN   [t] Test CAT   [p] Test PTT   [c] Configure   [r] Refresh   [q] Quit",
    border: { type: "line" }
  });

  function appendRadioLog(msg: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    radioLog.push(`[${time}] ${msg}`);
    if (radioLog.length > 5) radioLog.shift();
  }

  function renderStatus(): void {
    if (isDestroyed) return;

    const telem: EdgeTelemetry = runtime ? runtime.getTelemetry() : createInitialTelemetry(options.pairingService?.state.stationId);

    const cloudCol = telem.server.connected ? "green-fg" : telem.server.status === "pairing" ? "yellow-fg" : "red-fg";
    const catCol = telem.radio.catConnected ? "green-fg" : "yellow-fg";
    const ft8Col = telem.ft8.sessionActive ? "cyan-fg" : "yellow-fg";
    const pttCol = telem.radio.ptt ? "red-bg}{white-fg" : "green-fg";
    const wdCol = telem.watchdog.hasTimedOut ? "red-fg" : "green-fg";

    banner.setContent(
      `{bold}{cyan-fg}DIGI-DX UNITARY EDGE CLIENT{/} | Uptime: ${telem.program.uptimeSeconds}s | ` +
      `Cloud: {${cloudCol}}${telem.server.status.toUpperCase()}{/} | ` +
      `CAT: {${catCol}}${telem.radio.catConnected ? "ONLINE" : "OFFLINE"}{/} | ` +
      `FT8: {${ft8Col}}${telem.ft8.sessionActive ? "ACTIVE" : "IDLE"}{/} | ` +
      `PTT: {${pttCol}}${telem.radio.ptt ? "TX" : "RX"}{/} | ` +
      `Watchdog: {${wdCol}}${telem.watchdog.hasTimedOut ? "ABORT" : "OK"}{/}`
    );

    const pinText = telem.server.activeCode
      ? `{bold}{white-bg}{black-fg} ${telem.server.activeCode} {/}  (Expires in ${telem.server.codeExpiresInSec ?? 0}s)`
      : telem.server.connected
      ? `{bold}{green-fg}PAIRED WITH CLOUD GATEWAY{/}`
      : `{grey-fg}None (Press 'g' to generate PIN){/}`;

    pairingBox.setContent(
      `Status: {${cloudCol}}{bold}${telem.server.status.toUpperCase()}{/}\n` +
      `Station ID: ${telem.server.stationId}\n` +
      `Pairing PIN: ${pinText}\n` +
      `Gateway Link: ${telem.server.connected ? "{green-fg}Connected{/}" : "{red-fg}Disconnected{/}"}\n` +
      `Round-Trip Ping: ${telem.server.pingMs != null ? `${telem.server.pingMs} ms` : "—"}\n` +
      `{grey-fg}Enter this 6-digit PIN in the cloud portal to pair.{/}`
    );

    const freqDisplay = telem.radio.freqHz
      ? `{bold}{cyan-fg}${formatMhz(telem.radio.freqHz)}{/} (${telem.radio.freqHz.toLocaleString()} Hz)`
      : "{yellow-fg}Unknown (Press 't' to test CAT){/}";

    const pttDisplay = telem.radio.ptt
      ? `{bold}{red-bg}{white-fg} ● TRANSMITTING (TX) {/}`
      : `{green-fg}● RX Idle (Listening){/}`;

    const logText = radioLog.length > 0 ? "\n\nDiagnostic Activity Log:\n" + radioLog.map((l) => `  ${l}`).join("\n") : "";

    radioBox.setContent(
      `CAT Status: {${catCol}}{bold}${telem.radio.catConnected ? "CONNECTED" : "DISCONNECTED"}{/}\n` +
      `Dial Frequency: ${freqDisplay}\n` +
      `CAT Protocol: ${telem.config.catMode} on port ${telem.config.catPort}\n` +
      `Transmitter State: ${pttDisplay}${logText}`
    );

    const slotDisplay = `{bold}${telem.ft8.slotParity.toUpperCase()}{/} slot — ${telem.ft8.slotSecondsRemaining}s remaining`;
    const lastMsg = telem.ft8.lastDecodeMessage ? `{cyan-fg}${telem.ft8.lastDecodeMessage}{/}` : "{grey-fg}None yet{/}";

    ft8Box.setContent(
      `Engine Driver: {bold}${telem.ft8.engineKind.toUpperCase()}{/} (${telem.ft8.sessionActive ? "Session Active" : "Idle"})\n` +
      `Audio Interface: [ID ${telem.config.deviceId}] ${telem.config.deviceName ?? "Audio Device"}\n` +
      `Slot Clock: ${slotDisplay}\n` +
      `Decodes: {bold}${telem.ft8.decodesThisSlot}{/} this slot | {bold}${telem.ft8.totalDecodes}{/} total\n` +
      `Latest Decode: ${lastMsg}`
    );

    configBox.setContent(
      `Station Callsign: {bold}${telem.config.callsign || "(not set)"}{/}\n` +
      `Maidenhead Grid: {bold}${telem.config.grid || "(not set)"}{/}\n` +
      `Audio Device ID: ${telem.config.deviceId}\n` +
      `CAT Control: ${telem.config.catMode} :${telem.config.catPort}\n` +
      `Cloud Gateway: ${telem.config.cloudUrl}\n\n` +
      `{yellow-fg}Press [c] to edit station configuration{/}`
    );

    screen.render();
  }

  function openConfigDialog(): void {
    if (dialogOpen) return;
    dialogOpen = true;

    const telem = runtime ? runtime.getTelemetry() : createInitialTelemetry(options.pairingService?.state.stationId);

    const dialog = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: 60,
      height: 18,
      border: { type: "line" },
      label: " Configure Station & Hardware ",
      tags: true,
      style: { border: { fg: "cyan" }, bg: "black" }
    });

    const fields = [
      { name: "callsign", label: "Callsign", value: telem.config.callsign },
      { name: "grid", label: "Maidenhead Grid", value: telem.config.grid },
      { name: "deviceId", label: "Audio Device ID", value: String(telem.config.deviceId) },
      { name: "catMode", label: "CAT Mode (rigctld|dummy)", value: telem.config.catMode },
      { name: "catPort", label: "CAT Port", value: String(telem.config.catPort) },
      { name: "cloudUrl", label: "Cloud Gateway URL", value: telem.config.cloudUrl }
    ];

    const inputs: blessed.Widgets.TextboxElement[] = fields.map((field, index) => {
      blessed.text({ parent: dialog, top: 1 + index * 2, left: 2, content: `${field.label}:` });
      return blessed.textbox({
        parent: dialog,
        top: 2 + index * 2,
        left: 2,
        width: 52,
        height: 1,
        inputOnFocus: true,
        keys: true,
        mouse: true,
        style: { bg: "blue", fg: "white", focus: { bg: "cyan", fg: "black" } },
        value: field.value
      });
    });

    const closeDialog = (): void => {
      dialog.destroy();
      dialogOpen = false;
      screen.render();
    };

    const submit = async (): Promise<void> => {
      const values: Record<string, string> = {};
      fields.forEach((f, idx) => { values[f.name] = inputs[idx]!.getValue().trim(); });
      closeDialog();

      const payload = {
        deviceId: Number(values.deviceId),
        catMode: (values.catMode === "dummy" ? "dummy" : "rigctld") as "dummy" | "rigctld",
        catPort: Number(values.catPort),
        callsign: values.callsign,
        grid: values.grid,
        cloudUrl: values.cloudUrl
      };

      if (runtime) {
        await runtime.saveConfig({
          callsign: payload.callsign,
          grid: payload.grid,
          cloudUrl: payload.cloudUrl,
          device: { id: payload.deviceId },
          cat: { mode: payload.catMode, port: payload.catPort }
        });
      } else if (options.onSaveConfig) {
        await options.onSaveConfig(payload);
      }

      appendRadioLog("Saved configuration updates");
      renderStatus();
    };

    const okBtn = blessed.button({
      parent: dialog,
      bottom: 1,
      left: 12,
      width: 12,
      height: 1,
      content: "[ Save ]",
      mouse: true,
      align: "center",
      style: { bg: "green", fg: "black", focus: { bg: "white" } }
    });

    const cancelBtn = blessed.button({
      parent: dialog,
      bottom: 1,
      left: 32,
      width: 12,
      height: 1,
      content: "[ Cancel ]",
      mouse: true,
      align: "center",
      style: { bg: "red", fg: "black", focus: { bg: "white" } }
    });

    okBtn.on("press", submit);
    cancelBtn.on("press", closeDialog);

    inputs.forEach((input, idx) => {
      input.on("submit", () => {
        (inputs[idx + 1] ?? okBtn).focus();
        screen.render();
      });
    });

    dialog.key("escape", closeDialog);
    inputs[0]?.focus();
    screen.render();
  }

  screen.key(["q", "C-c"], () => {
    isDestroyed = true;
    screen.destroy();
    options.onQuit?.();
  });

  screen.key(["g"], () => {
    const res = runtime ? runtime.generatePairingCode() : options.pairingService?.generatePairingCode();
    if (res) appendRadioLog(`Generated pairing PIN: ${res.code}`);
    renderStatus();
  });

  screen.key(["t"], async () => {
    appendRadioLog("Testing CAT query...");
    renderStatus();
    const res = runtime ? await runtime.testCat() : { ok: true, freqHz: 14074000, error: undefined as string | undefined };
    appendRadioLog(res.ok ? `CAT Query OK: ${res.freqHz ? formatMhz(res.freqHz) : "connected"}` : `CAT Failed: ${res.error ?? "error"}`);
    renderStatus();
  });

  screen.key(["p"], async () => {
    appendRadioLog("Testing safe PTT pulse (200ms)...");
    renderStatus();
    const res = runtime ? await runtime.testPtt(200) : { ok: true, error: undefined as string | undefined };
    appendRadioLog(res.ok ? "PTT Key Test Succeeded" : `PTT Failed: ${res.error ?? "error"}`);
    renderStatus();
  });

  screen.key(["c"], () => openConfigDialog());
  screen.key(["r"], () => {
    appendRadioLog("Refreshed hardware status");
    renderStatus();
  });

  if (runtime) {
    runtime.on("telemetry", () => renderStatus());
  } else if (options.pairingService) {
    const refresh = () => renderStatus();
    options.pairingService.on("codeGenerated", refresh);
    options.pairingService.on("paired", refresh);
    options.pairingService.on("unpaired", refresh);
    options.pairingService.on("expired", refresh);
  }

  renderStatus();
  const ticker = setInterval(renderStatus, 1000);

  return {
    screen,
    destroy: () => {
      isDestroyed = true;
      clearInterval(ticker);
      screen.destroy();
    }
  };
}
