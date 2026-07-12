import { describe, expect, it } from "vitest";
import { driverDecodeToEvent, driverTxToEvent } from "../src/daemon/engine-driver.js";
import {
  detectHostArch,
  resolveEngineBinaryPaths
} from "../src/daemon/engine-binary-paths.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("engine driver mappers", () => {
  it("maps driver decode to protocol decode", () => {
    expect(
      driverDecodeToEvent({
        ts: 1783048560,
        snr: 10,
        dt: -0.6,
        af: 2024,
        mode: "FT8",
        message: "wm8q dl0eo -17"
      })
    ).toEqual({
      type: "decode",
      ts: 1783048560,
      snr: 10,
      dt: -0.6,
      af: 2024,
      mode: "FT8",
      message: "WM8Q DL0EO -17"
    });
  });

  it("maps driver tx to protocol tx", () => {
    expect(
      driverTxToEvent({
        ts: 1783005075,
        af: 1000,
        mode: "FT8",
        message: "cq n1mpm fn42"
      })
    ).toEqual({
      type: "tx",
      ts: 1783005075,
      af: 1000,
      mode: "FT8",
      message: "CQ N1MPM FN42"
    });
  });
});

describe("resolveEngineBinaryPaths", () => {
  it("prefers env overrides over manifest and defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-paths-"));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        arch: "x86_64",
        bins: { ft8cat: "/vendor/ft8cat", ft8modem: "/vendor/ft8modem", rigctld: "/vendor/rigctld" }
      })
    );

    const paths = await resolveEngineBinaryPaths({
      manifestPath,
      repoRoot: dir,
      env: {
        DIGI_DX_FT8CAT_PATH: "/env/ft8cat",
        DIGI_DX_FT8MODEM_PATH: "/env/ft8modem"
      }
    });

    expect(paths).toEqual({
      ft8cat: "/env/ft8cat",
      ft8modem: "/env/ft8modem",
      rigctld: "rigctld"
    });
  });

  it("loads manifest paths when env overrides are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-paths-"));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        arch: detectHostArch(),
        bins: {
          ft8cat: "vendor/engine/x86_64/bin/ft8cat",
          ft8modem: "vendor/engine/x86_64/bin/ft8modem",
          rigctld: "vendor/engine/x86_64/bin/rigctld"
        }
      })
    );

    const paths = await resolveEngineBinaryPaths({ manifestPath, repoRoot: dir, env: {} });
    expect(paths.ft8cat).toBe(join(dir, "vendor/engine/x86_64/bin/ft8cat"));
    expect(paths.ft8modem).toBe(join(dir, "vendor/engine/x86_64/bin/ft8modem"));
    expect(paths.rigctld).toBe(join(dir, "vendor/engine/x86_64/bin/rigctld"));
  });

  it("throws on manifest arch mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-paths-"));
    const manifestPath = join(dir, "manifest.json");
    const hostArch = detectHostArch();
    const otherArch = hostArch === "x86_64" ? "aarch64" : "x86_64";
    await writeFile(
      manifestPath,
      JSON.stringify({
        arch: otherArch,
        bins: { ft8cat: "a", ft8modem: "b", rigctld: "c" }
      })
    );

    await expect(resolveEngineBinaryPaths({ manifestPath, repoRoot: dir, env: {} })).rejects.toMatchObject({
      code: "ENGINE_MANIFEST_ARCH_MISMATCH"
    });
  });

  it("throws on corrupt manifest JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digi-dx-paths-"));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, "{not json");

    await expect(resolveEngineBinaryPaths({ manifestPath, repoRoot: dir, env: {} })).rejects.toMatchObject({
      code: "ENGINE_MANIFEST_INVALID"
    });
  });
});
