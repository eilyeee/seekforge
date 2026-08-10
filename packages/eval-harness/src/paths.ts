/** Repo-root-relative locations of the eval dataset and reports. */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const evalsDir = join(repoRoot, "evals");
export const tasksDir = join(evalsDir, "tasks");
export const fixturesDir = join(evalsDir, "fixtures");
export const reportsDir = join(evalsDir, "reports");

/**
 * Where `--baseline <file>` actually is.
 *
 * The documented invocation is `pnpm --filter @seekforge/eval-harness eval --
 * --baseline evals/baseline.json`, and pnpm runs that with the cwd set to the
 * package, not the repository — so the path in the README resolved against the
 * wrong directory and the file was simply not there. Relative paths are tried
 * against the cwd first (what a shell user means) and then the repo root (what
 * the README means); an absolute path is taken as given. Readability is not
 * checked here: the caller reports that, after writing its report.
 */
export function resolveBaselinePath(baseline: string): string {
  if (isAbsolute(baseline)) return baseline;
  const fromCwd = resolve(process.cwd(), baseline);
  return existsSync(fromCwd) ? fromCwd : resolve(repoRoot, baseline);
}
