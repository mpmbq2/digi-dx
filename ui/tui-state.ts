import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const defaultStatePath = join(process.cwd(), "data", "tui-state.json");

export interface TuiState {
  dialFreqHz: number | null;
}

export async function readTuiState(path = defaultStatePath): Promise<TuiState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { dialFreqHz: null };
    }
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { dialFreqHz: null };
  }

  return {
    dialFreqHz: normalizeDialFreqHz((parsed as Record<string, unknown>).dialFreqHz)
  };
}

export async function writeTuiState(state: TuiState, path = defaultStatePath): Promise<void> {
  const dir = dirname(path);
  const tmpPath = `${path}.tmp`;
  const data = `${JSON.stringify({ dialFreqHz: normalizeDialFreqHz(state.dialFreqHz) }, null, 2)}\n`;

  await mkdir(dir, { recursive: true });
  const file = await open(tmpPath, "w", 0o600);
  try {
    await file.writeFile(data, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmpPath, path);
}

function normalizeDialFreqHz(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}
