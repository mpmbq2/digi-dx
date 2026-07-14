import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Paths whose modification voids "independent confirmation" of a green smoke
// (R17). Includes the smoke scripts themselves so an agent cannot loosen the
// simulator and quietly edit the banner logic in the same change.
export const INDEPENDENCE_WATCHED_PATHS = [
  "src/daemon/sim-station.ts",
  "src/daemon/simulated-driver.ts",
  "test/sim-station.test.ts",
  "scripts/smoke.ts",
  "scripts/smoke-ui.ts",
  "scripts/smoke-ui-countdown.ts",
  "scripts/smoke-independence.ts",
  "scripts/smoke-assert.ts"
] as const;

export const NO_MERGE_BASE_MESSAGE = "cannot establish independence: no merge base.";
export const NOT_INDEPENDENT_BANNER =
  "not-independent-confirmation: this run touched simulator sequencing, conformance tests, or smoke scripts — a green result is not independent confirmation.";

export interface IndependenceInput {
  /** Null when git cannot resolve a merge base (shallow/detached). */
  mergeBase: string | null;
  /** Paths changed in the committed range plus working tree. */
  changedPaths: string[];
  watchedPaths?: readonly string[];
}

export interface IndependenceResult {
  ok: boolean;
  banner: string | null;
  touchedWatched: string[];
  reason: string | null;
}

export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function classifyWatchedChanges(
  changedPaths: string[],
  watchedPaths: readonly string[] = INDEPENDENCE_WATCHED_PATHS
): string[] {
  const watched = new Set(watchedPaths.map(normalizeRepoPath));
  const touched = new Set<string>();
  for (const raw of changedPaths) {
    const path = normalizeRepoPath(raw);
    if (watched.has(path)) {
      touched.add(path);
    }
  }
  return [...touched].sort();
}

export function evaluateIndependence(input: IndependenceInput): IndependenceResult {
  if (input.mergeBase === null) {
    return {
      ok: false,
      banner: null,
      touchedWatched: [],
      reason: NO_MERGE_BASE_MESSAGE
    };
  }

  const touchedWatched = classifyWatchedChanges(input.changedPaths, input.watchedPaths);
  return {
    ok: true,
    banner: touchedWatched.length > 0 ? NOT_INDEPENDENT_BANNER : null,
    touchedWatched,
    reason: null
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

export async function resolveMergeBase(
  cwd: string,
  candidates: string[] = ["origin/main", "main"]
): Promise<string | null> {
  for (const ref of candidates) {
    try {
      const base = (await git(cwd, ["merge-base", ref, "HEAD"])).trim();
      if (base) {
        return base;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export async function collectChangedPaths(cwd: string, mergeBase: string): Promise<string[]> {
  const chunks = await Promise.all([
    git(cwd, ["diff", "--name-only", `${mergeBase}...HEAD`]),
    git(cwd, ["diff", "--name-only"]),
    git(cwd, ["diff", "--name-only", "--cached"]),
    // Untracked files are part of the working tree a reviewer cannot see in the
    // committed range alone — include them so a new smoke bypass still banners.
    git(cwd, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const paths = new Set<string>();
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        paths.add(normalizeRepoPath(trimmed));
      }
    }
  }
  return [...paths].sort();
}

export async function checkIndependenceFromGit(cwd: string): Promise<IndependenceResult> {
  const mergeBase = await resolveMergeBase(cwd);
  if (mergeBase === null) {
    return evaluateIndependence({ mergeBase: null, changedPaths: [] });
  }
  const changedPaths = await collectChangedPaths(cwd, mergeBase);
  return evaluateIndependence({ mergeBase, changedPaths });
}
