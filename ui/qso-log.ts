import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QsoLogEntry } from "../core/qso.js";
import type { EngineKind } from "../core/protocol.js";

const defaultLogPath = join(process.cwd(), "data", "qso-log.jsonl");

// Demo QSOs go to a different file, not to the same file with a flag on them.
// A flagged entry can still be exported to ADIF by a code path that forgets to
// check the flag -- and a fabricated contact uploaded to LoTW or QRZ is not a
// bug you get to take back. Isolation by construction, not by discipline.
const demoLogPath = join(process.cwd(), "data", "demo-qso-log.jsonl");

// The ADIF exporter is never pointed at this. It reads the real log only.
export function qsoLogPathFor(engine: EngineKind): string {
  return engine === "simulated" ? demoLogPath : defaultLogPath;
}

export function realQsoLogPath(): string {
  return defaultLogPath;
}

export async function appendQsoLog(
  entry: QsoLogEntry,
  path = defaultLogPath
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

// Read every logged QSO. Returns an empty list when the log does not exist yet;
// malformed lines are skipped so a partial write never breaks export/recall.
export async function readQsoLog(path = defaultLogPath): Promise<QsoLogEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries: QsoLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as QsoLogEntry);
    } catch {
      // Skip a corrupt/partial line rather than failing the whole read.
    }
  }
  return entries;
}
