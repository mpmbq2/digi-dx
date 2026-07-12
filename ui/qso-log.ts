import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QsoLogEntry } from "../core/qso.js";

const defaultLogPath = join(process.cwd(), "data", "qso-log.jsonl");

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
