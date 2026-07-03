import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QsoLogEntry } from "./qso.js";

export async function appendQsoLog(
  entry: QsoLogEntry,
  path = join(process.cwd(), "data", "qso-log.jsonl")
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
