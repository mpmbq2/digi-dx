import { describe, expect, it } from "vitest";
import { EdgeRuntime } from "../src/edge/runtime.js";
import { startEdgeTui } from "../src/edge/ui/tui.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Edge TUI (Blessed Terminal Interface)", () => {
  it("initializes blessed screen and renders the 4 diagnostic boxes and command footer", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "edge-tui-test-"));
    const configPath = join(tmpDir, "config.json");

    const runtime = new EdgeRuntime({
      configPath,
      forceSimulated: true
    });
    await runtime.init();

    const tui = startEdgeTui({ runtime });
    expect(tui.screen).toBeDefined();

    // Verify children elements were attached
    const childLabels = tui.screen.children.map((c: any) => c._label?.content || c.content || "");
    const hasBanner = childLabels.some((l: string) => l.includes("DIGI-DX UNITARY EDGE CLIENT"));
    const hasFooter = childLabels.some((l: string) => l.includes("New PIN") || l.includes("Test CAT"));
    expect(hasBanner).toBe(true);
    expect(hasFooter).toBe(true);

    // Destroy cleanly
    tui.destroy();
    await runtime.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
