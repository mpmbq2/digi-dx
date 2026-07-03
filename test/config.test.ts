import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig, validateSessionConfig } from "../src/daemon/config.js";
import { DaemonError } from "../src/daemon/protocol.js";

const completeSession = {
  mode: "FT8",
  device: { id: 141, name: "USB Audio CODEC (USB Audio)" },
  callsign: "n1mpm",
  grid: "fn33",
  cat: { mode: "dummy", port: 4532 }
};

describe("config", () => {
  it("validates and normalizes a complete session", () => {
    expect(validateSessionConfig(completeSession)).toEqual({
      mode: "FT8",
      device: { id: 141, name: "USB Audio CODEC (USB Audio)" },
      callsign: "N1MPM",
      grid: "FN33",
      cat: { mode: "dummy", port: 4532 }
    });
  });

  it("reports missing fields without accepting partial config", () => {
    expect(() => validateSessionConfig({ mode: "FT8", device: {} })).toThrowError(DaemonError);
    try {
      validateSessionConfig({ mode: "FT8", device: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonError);
      expect((error as DaemonError).code).toBe("CONFIG_REQUIRED");
      expect((error as DaemonError).details).toEqual({
        missing: ["callsign", "grid", "cat.mode", "cat.port"]
      });
    }
  });

  it("atomically writes and reloads complete config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-config-"));
    const path = join(dir, "config.json");

    const saved = await saveConfig(completeSession, path);
    expect(saved.callsign).toBe("N1MPM");
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
    await expect(loadConfig(path)).resolves.toMatchObject({
      complete: true,
      invalid: false,
      session: saved
    });
  });

  it("preserves invalid config until an explicit save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, "{not-json", "utf8");

    const loaded = await loadConfig(path);
    expect(loaded.complete).toBe(false);
    expect(loaded.invalid).toBe(true);
    expect(await readFile(path, "utf8")).toBe("{not-json");

    await saveConfig(completeSession, path);
    expect((await loadConfig(path)).complete).toBe(true);
  });
});
