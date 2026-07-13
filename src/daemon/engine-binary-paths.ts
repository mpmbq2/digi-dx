import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonError } from "./protocol.js";

export type EngineArch = "x86_64" | "aarch64";

export interface EngineBinaryPaths {
  ft8cat: string;
  ft8modem: string;
  rigctld: string;
}

export interface EngineManifest {
  arch: EngineArch;
  version?: string;
  bins: EngineBinaryPaths & {
    jt9?: string;
    ft8code?: string;
    ft4code?: string;
  };
}

export interface ResolveEngineBinaryPathsOptions {
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
  repoRoot?: string;
}

const DEFAULT_COMMANDS: EngineBinaryPaths = {
  ft8cat: "ft8cat",
  ft8modem: "ft8modem",
  rigctld: "rigctld"
};

export function detectHostArch(unameMachine = process.platform === "linux" ? undefined : "x86_64"): EngineArch {
  const machine = unameMachine ?? detectUnameMachine();
  if (machine === "x86_64" || machine === "amd64") {
    return "x86_64";
  }
  if (machine === "aarch64" || machine === "arm64") {
    return "aarch64";
  }
  throw new DaemonError("ENGINE_ARCH_UNSUPPORTED", `unsupported CPU architecture: ${machine}`, { arch: machine });
}

export async function resolveEngineBinaryPaths(
  options: ResolveEngineBinaryPathsOptions = {}
): Promise<EngineBinaryPaths> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const manifestPath = options.manifestPath ?? join(repoRoot, "vendor/engine/manifest.json");

  const fromEnv = resolveFromEnv(env);
  if (fromEnv) {
    return fromEnv;
  }

  const fromManifest = await loadManifestPaths(manifestPath, repoRoot);
  if (fromManifest) {
    return fromManifest;
  }

  return { ...DEFAULT_COMMANDS };
}

function resolveFromEnv(env: NodeJS.ProcessEnv): EngineBinaryPaths | null {
  const ft8cat = env.DIGI_DX_FT8CAT_PATH;
  const ft8modem = env.DIGI_DX_FT8MODEM_PATH;
  const rigctld = env.DIGI_DX_RIGCTLD_PATH;
  if (!ft8cat && !ft8modem && !rigctld) {
    return null;
  }
  return {
    ft8cat: ft8cat ?? DEFAULT_COMMANDS.ft8cat,
    ft8modem: ft8modem ?? DEFAULT_COMMANDS.ft8modem,
    rigctld: rigctld ?? DEFAULT_COMMANDS.rigctld
  };
}

async function loadManifestPaths(manifestPath: string, repoRoot: string): Promise<EngineBinaryPaths | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new DaemonError("ENGINE_MANIFEST_INVALID", "failed to read engine manifest", {
      path: manifestPath,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DaemonError("ENGINE_MANIFEST_INVALID", "engine manifest is not valid JSON", {
      path: manifestPath,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const manifest = validateManifest(parsed, manifestPath);
  const hostArch = detectHostArch();
  if (manifest.arch !== hostArch) {
    throw new DaemonError("ENGINE_MANIFEST_ARCH_MISMATCH", "engine manifest architecture does not match host", {
      manifestArch: manifest.arch,
      hostArch
    });
  }

  return {
    ft8cat: resolveBinPath(manifest.bins.ft8cat, repoRoot),
    ft8modem: resolveBinPath(manifest.bins.ft8modem, repoRoot),
    rigctld: resolveBinPath(manifest.bins.rigctld, repoRoot)
  };
}

function validateManifest(input: unknown, manifestPath: string): EngineManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DaemonError("ENGINE_MANIFEST_INVALID", "engine manifest must be an object", { path: manifestPath });
  }

  const raw = input as Record<string, unknown>;
  if (raw.arch !== "x86_64" && raw.arch !== "aarch64") {
    throw new DaemonError("ENGINE_MANIFEST_INVALID", "engine manifest arch must be x86_64 or aarch64", {
      path: manifestPath
    });
  }

  const bins = raw.bins;
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) {
    throw new DaemonError("ENGINE_MANIFEST_INVALID", "engine manifest bins must be an object", { path: manifestPath });
  }

  const rawBins = bins as Record<string, unknown>;
  for (const key of ["ft8cat", "ft8modem", "rigctld"] as const) {
    if (typeof rawBins[key] !== "string" || !rawBins[key]) {
      throw new DaemonError("ENGINE_MANIFEST_INVALID", `engine manifest bins.${key} must be a non-empty string`, {
        path: manifestPath
      });
    }
  }

  return {
    arch: raw.arch,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    bins: {
      ft8cat: rawBins.ft8cat as string,
      ft8modem: rawBins.ft8modem as string,
      rigctld: rawBins.rigctld as string,
      ...(typeof rawBins.jt9 === "string" ? { jt9: rawBins.jt9 } : {}),
      ...(typeof rawBins.ft8code === "string" ? { ft8code: rawBins.ft8code } : {}),
      ...(typeof rawBins.ft4code === "string" ? { ft4code: rawBins.ft4code } : {})
    }
  };
}

function resolveBinPath(path: string, repoRoot: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function detectUnameMachine(): string {
  try {
    return execSync("uname -m", { encoding: "utf8" }).trim();
  } catch {
    return "x86_64";
  }
}
