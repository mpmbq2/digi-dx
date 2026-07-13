import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTuiState, writeTuiState } from "../ui/tui-state.js";

describe("TUI state", () => {
  it("returns an empty state when the file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-tui-state-"));
    await expect(readTuiState(join(dir, "missing.json"))).resolves.toEqual({ dialFreqHz: null });
  });

  it("persists the manual dial frequency atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-tui-state-"));
    const path = join(dir, "state.json");

    await writeTuiState({ dialFreqHz: 14_074_000 }, path);

    expect(await readTuiState(path)).toEqual({ dialFreqHz: 14_074_000 });
    expect(await readFile(path, "utf8")).toContain('"dialFreqHz": 14074000');
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  it("normalizes invalid stored frequencies to null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-tui-state-"));
    const path = join(dir, "state.json");

    await writeFile(path, JSON.stringify({ dialFreqHz: "14.074" }), "utf8");

    expect(await readTuiState(path)).toEqual({ dialFreqHz: null });
  });
});
