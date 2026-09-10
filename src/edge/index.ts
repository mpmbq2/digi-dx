export * from "./watchdog.js";
export * from "./pairing.js";
export * from "./ui/gui.js";
export * from "./ui/tui.js";

import { Engine } from "../daemon/engine.js";
import { EdgePairingService } from "./pairing.js";
import { createEdgeGuiServer } from "./ui/gui.js";
import { listAudioDevices } from "../daemon/audio-devices.js";

// Unitary Edge Client Bootstrap (R1, R2, R3, R4)
export interface EdgeClientOptions {
  guiPort?: number;
  guiHost?: string;
  enableWatchdog?: boolean;
  watchdogTimeoutMs?: number;
}

export async function bootstrapEdgeClient(options: EdgeClientOptions = {}) {
  const pairingService = new EdgePairingService();
  const gui = createEdgeGuiServer({
    port: options.guiPort ?? 8792,
    host: options.guiHost ?? "127.0.0.1",
    pairingService,
    listAudioDevices
  });

  return {
    pairingService,
    gui
  };
}
