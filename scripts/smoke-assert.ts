import { readFile } from "node:fs/promises";
import type { QsoLogEntry } from "../core/qso.js";

// Must match DEMO_CALLSIGN / DEMO_GRID in src/daemon/simulated-driver.ts
const EXPECTED_MY_CALL = "QQ0DEMO";
const EXPECTED_MY_GRID = "FN42";

export interface WaitForDemoQsoOptions {
  timeoutMs: number;
  pollMs?: number;
}

export class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeFailure";
  }
}

export async function readDemoLogEntries(path: string): Promise<QsoLogEntry[]> {
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
      // Skip corrupt/partial line.
    }
  }
  return entries;
}

/** Poll until the demo log gains at least one entry, or fail with a phone-legible reason. */
export async function waitForDemoQsoEntry(
  path: string,
  options: WaitForDemoQsoOptions
): Promise<QsoLogEntry> {
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readDemoLogEntries(path);
    if (entries.length > 0) {
      return entries[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new SmokeFailure(
    `smoke failed: no QSO logged to ${path} within ${options.timeoutMs}ms ` +
      `(no answerable decode / TX path did not complete a contact)`
  );
}

export function assertExpectedDemoQso(entry: QsoLogEntry): void {
  if (entry.myCall !== EXPECTED_MY_CALL) {
    throw new SmokeFailure(
      `smoke failed: expected myCall ${EXPECTED_MY_CALL}, got ${JSON.stringify(entry.myCall)}`
    );
  }
  if (entry.myGrid !== EXPECTED_MY_GRID) {
    throw new SmokeFailure(
      `smoke failed: expected myGrid ${EXPECTED_MY_GRID}, got ${JSON.stringify(entry.myGrid)}`
    );
  }
  if (!entry.theirCall || typeof entry.theirCall !== "string") {
    throw new SmokeFailure("smoke failed: logged QSO missing theirCall");
  }
  if (!entry.theirCall.startsWith("QQ")) {
    throw new SmokeFailure(
      `smoke failed: theirCall ${entry.theirCall} is not a simulated (QQ) callsign`
    );
  }
  if (!entry.sentReport || !entry.receivedReport) {
    throw new SmokeFailure(
      `smoke failed: incomplete reports sent=${entry.sentReport} received=${entry.receivedReport}`
    );
  }
  if (!entry.txMessages?.length || !entry.rxMessages?.length) {
    throw new SmokeFailure("smoke failed: logged QSO missing tx/rx message history");
  }
}
