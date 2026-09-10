import blessed from "blessed";
import type { EdgePairingService } from "../pairing.js";
import type { AudioDevice } from "../../daemon/audio-devices.js";

// Minimal local TUI screen running on the edge machine (R2).
// Exposes hardware device selection, serial port setup, and 6-digit pairing PIN display.

export interface EdgeTuiOptions {
  pairingService: EdgePairingService;
  listAudioDevices: () => Promise<AudioDevice[]>;
  onSaveConfig?: (config: { deviceId: number; catPort: number }) => Promise<void>;
  onQuit?: () => void;
}

export function startEdgeTui(options: EdgeTuiOptions): { screen: blessed.Widgets.Screen; destroy: () => void } {
  const screen = blessed.screen({
    smartCSR: true,
    title: "Digi-Dx Edge Radio Setup & Pairing"
  });

  const banner = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: "{bold}{cyan-fg}DIGI-DX UNITARY EDGE CLIENT{/} — Minimal Hardware & Pairing Console",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } }
  });

  const pairingBox = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "100%",
    height: 8,
    label: " Cloud Pairing (6-Digit PIN) ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "yellow" } }
  });

  const devicesBox = blessed.box({
    parent: screen,
    top: 11,
    left: 0,
    width: "100%",
    height: "100%-14",
    label: " Hardware Interfaces (Soundcard & CAT) ",
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "green" } }
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: " [g] Generate New PIN   [r] Refresh Status   [q] Quit",
    border: { type: "line" }
  });

  function renderStatus(): void {
    const state = options.pairingService.state;
    const statusColor = state.status === "paired" ? "green-fg" : "yellow-fg";
    const codeDisplay = state.activeCode ? `{bold}{white-bg}{black-fg} ${state.activeCode} {/}` : "{grey-fg}None (Press 'g' to generate){/}";
    const expiryDisplay = state.expiresAt ? `Expires in: ${Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000))}s` : "";

    pairingBox.setContent(
      `Status: {${statusColor}}{bold}${state.status.toUpperCase()}{/}\n` +
      `Station ID: ${state.stationId}\n` +
      `Pairing PIN: ${codeDisplay}  ${expiryDisplay}\n` +
      `Enter this code in the Digi-Dx Cloud Portal to connect.`
    );
    screen.render();
  }

  async function loadDevices(): Promise<void> {
    try {
      const devices = await options.listAudioDevices();
      let text = "Discovered Audio Devices:\n";
      devices.forEach((d) => {
        text += `  • [ID ${d.id}] ${d.name} (${d.inputs} in, ${d.outputs} out)\n`;
      });
      devicesBox.setContent(text);
      screen.render();
    } catch (err) {
      devicesBox.setContent(`Error loading audio devices: ${String(err)}`);
      screen.render();
    }
  }

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    options.onQuit?.();
  });

  screen.key(["g"], () => {
    options.pairingService.generatePairingCode();
    renderStatus();
  });

  screen.key(["r"], () => {
    void loadDevices();
    renderStatus();
  });

  options.pairingService.on("codeGenerated", () => renderStatus());
  options.pairingService.on("paired", () => renderStatus());
  options.pairingService.on("unpaired", () => renderStatus());
  options.pairingService.on("expired", () => renderStatus());

  renderStatus();
  void loadDevices();

  return {
    screen,
    destroy: () => screen.destroy()
  };
}
