export * from "./watchdog.js";
export * from "./pairing.js";
export * from "./runtime.js";
export * from "./ui/gui.js";
export * from "./ui/tui.js";

import { EdgeRuntime, type EdgeRuntimeOptions } from "./runtime.js";
import { createEdgeGuiServer, type EdgeGuiServer } from "./ui/gui.js";
import { startEdgeTui } from "./ui/tui.js";

// Unitary Edge Client Bootstrap (R1, R2, R3, R4)
export interface EdgeClientOptions extends EdgeRuntimeOptions {
  ui?: "gui" | "tui" | "both" | "none";
  guiPort?: number;
  guiHost?: string;
  onQuit?: () => void | Promise<void>;
}

export async function bootstrapEdgeClient(options: EdgeClientOptions = {}) {
  const runtime = new EdgeRuntime(options);
  await runtime.init();

  let gui: EdgeGuiServer | undefined;
  const uiMode = options.ui ?? "gui";

  if (uiMode === "gui" || uiMode === "both") {
    gui = createEdgeGuiServer({
      port: options.guiPort ?? 8792,
      host: options.guiHost ?? "0.0.0.0",
      runtime
    });
  }

  let tui: ReturnType<typeof startEdgeTui> | undefined;
  if (uiMode === "tui" || uiMode === "both") {
    tui = startEdgeTui({
      runtime,
      onQuit: options.onQuit
    });
  }

  return {
    runtime,
    gui,
    tui,
    stop: async () => {
      if (tui) {
        tui.destroy();
      }
      if (gui) {
        await gui.close();
      }
      await runtime.stop();
    }
  };
}
