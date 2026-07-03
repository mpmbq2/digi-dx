import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonError } from "./protocol.js";

export interface SessionConfig {
  mode: "FT8";
  device: {
    id: number;
    name?: string;
  };
  callsign: string;
  grid: string;
  cat: {
    mode: "rigctld" | "dummy";
    port: number;
  };
}

export interface ConfigFile {
  session: SessionConfig;
}

export interface ConfigLoadResult {
  session: SessionConfig | null;
  complete: boolean;
  missing: string[];
  invalid: boolean;
  error?: string;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIGI_DX_CONFIG_PATH || "/var/lib/digi-dx/config.json";
}

export function validateSessionConfig(input: unknown): SessionConfig {
  const missing: string[] = [];
  const errors: string[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DaemonError("CONFIG_INVALID", "session config must be an object");
  }

  const raw = input as Record<string, unknown>;

  if (raw.mode === undefined) {
    missing.push("mode");
  } else if (raw.mode !== "FT8") {
    errors.push("mode must be 'FT8'");
  }

  const device = raw.device;
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    missing.push("device.id");
  }

  const rawDevice = (device ?? {}) as Record<string, unknown>;
  if (device && !Number.isInteger(rawDevice.id)) {
    errors.push("device.id must be an integer");
  }
  if (rawDevice.name !== undefined && typeof rawDevice.name !== "string") {
    errors.push("device.name must be a string");
  }

  const callsign = typeof raw.callsign === "string" ? raw.callsign.trim().toUpperCase() : undefined;
  if (!callsign) {
    missing.push("callsign");
  } else if (!/^[A-Z0-9/]{3,16}$/.test(callsign)) {
    errors.push("callsign must match [A-Z0-9/]{3,16}");
  }

  const grid = typeof raw.grid === "string" ? raw.grid.trim().toUpperCase() : undefined;
  if (!grid) {
    missing.push("grid");
  } else if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(grid)) {
    errors.push("grid must be a 4- or 6-character Maidenhead locator");
  }

  const cat = raw.cat;
  if (!cat || typeof cat !== "object" || Array.isArray(cat)) {
    missing.push("cat.mode", "cat.port");
  }

  const rawCat = (cat ?? {}) as Record<string, unknown>;
  if (cat && rawCat.mode !== "rigctld" && rawCat.mode !== "dummy") {
    errors.push("cat.mode must be 'rigctld' or 'dummy'");
  }
  if (cat && !isTcpPort(rawCat.port)) {
    errors.push("cat.port must be an integer from 1 to 65535");
  }

  if (missing.length > 0) {
    throw new DaemonError("CONFIG_REQUIRED", `missing config fields: ${missing.join(", ")}`, {
      missing
    });
  }

  if (errors.length > 0) {
    throw new DaemonError("CONFIG_INVALID", errors.join("; "));
  }

  return {
    mode: "FT8",
    device: {
      id: rawDevice.id as number,
      ...(rawDevice.name === undefined ? {} : { name: (rawDevice.name as string).trim() })
    },
    callsign: callsign!,
    grid: grid!,
    cat: {
      mode: rawCat.mode as "rigctld" | "dummy",
      port: rawCat.port as number
    }
  };
}

export function validateConfigFile(input: unknown): ConfigFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DaemonError("CONFIG_INVALID", "config file must be an object");
  }

  return {
    session: validateSessionConfig((input as Record<string, unknown>).session)
  };
}

export async function loadConfig(configPath = resolveConfigPath()): Promise<ConfigLoadResult> {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    return {
      session: null,
      complete: false,
      missing: ["mode", "device.id", "callsign", "grid"],
      invalid: false
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return {
      session: null,
      complete: false,
      missing: [],
      invalid: true,
      error: error instanceof Error ? error.message : "invalid config"
    };
  }

  try {
    const config = validateConfigFile(parsed);
    return {
      session: config.session,
      complete: true,
      missing: [],
      invalid: false
    };
  } catch (error) {
    const missing =
      error instanceof DaemonError &&
      error.details &&
      typeof error.details === "object" &&
      Array.isArray((error.details as { missing?: unknown }).missing)
        ? ((error.details as { missing: string[] }).missing)
        : [];

    return {
      session: null,
      complete: false,
      missing,
      invalid: true,
      error: error instanceof Error ? error.message : "invalid config"
    };
  }
}

export async function saveConfig(session: unknown, configPath = resolveConfigPath()): Promise<SessionConfig> {
  const validated = validateSessionConfig(session);
  const dir = dirname(configPath);
  const tmpPath = `${configPath}.tmp`;
  const data = `${JSON.stringify({ session: validated }, null, 2)}\n`;

  try {
    await mkdir(dir, { recursive: true });
    const file = await open(tmpPath, "w", 0o600);
    try {
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(tmpPath, configPath);
    await fsyncDirectoryBestEffort(dir);
  } catch (error) {
    throw new DaemonError("CONFIG_WRITE_FAILED", "failed to write config", {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return validated;
}

function isTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

async function fsyncDirectoryBestEffort(dir: string): Promise<void> {
  try {
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some filesystems do not support directory fsync; atomic rename already happened.
  }
}
