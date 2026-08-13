import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOOP_TIMEOUT_MS } from "../src/loop-verification-contract.js";
import { MAX_TIMER_DELAY_MS } from "../src/timers.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every source tree that could hold a second copy of the ceiling, **derived**
 * from the workspace globs rather than listed. Naming `packages` and `apps`
 * here would reproduce the blind spot the two drift gates have been widened for
 * five times: a tree added somewhere new is exempt by default and nothing says
 * so. `scripts` and `examples` are the two source trees that are not packages,
 * added the same way `doc-claim-reachability.test.mjs` adds them.
 */
function sourceRoots(): string[] {
  const globs = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8")
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*"?([^"\s#]+)"?\s*$/.exec(line)?.[1])
    .filter((glob): glob is string => glob?.endsWith("/*") === true);
  expect(globs.length).toBeGreaterThan(0);
  const roots: string[] = [];
  for (const glob of globs) {
    const parent = join(REPO_ROOT, glob.slice(0, -2));
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(parent, entry.name, "src"));
    }
  }
  for (const extra of ["scripts", "examples"]) roots.push(join(REPO_ROOT, extra));
  return roots;
}

/** Source files under `dir`, skipping dependencies and colocated tests. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "__tests__", "tests"].includes(entry.name)) files.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) && !/\.(d\.ts|test\.[a-z]+)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe("MAX_TIMER_DELAY_MS", () => {
  const warningListeners = process.listeners("warning");
  afterEach(() => {
    process.removeAllListeners("warning");
    for (const listener of warningListeners) process.on("warning", listener);
  });

  /**
   * The point of the constant, observed rather than asserted about.
   *
   * A test that only says `expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)`
   * agrees with the code by construction and would keep passing if the number
   * were wrong for the platform. This one asks the platform: one millisecond
   * past the constant, `setTimeout` stops waiting and fires on the next tick,
   * and at the constant it does not. That is the whole bug this ceiling exists
   * to prevent — the longest wait available silently becoming the shortest.
   */
  it("is exactly where setTimeout stops waiting and starts firing immediately", async () => {
    // Node prints a TimeoutOverflowWarning for the deliberate overflow below.
    process.removeAllListeners("warning");
    process.on("warning", () => {});

    const fired: string[] = [];
    const overflowing = setTimeout(() => fired.push("past the ceiling"), MAX_TIMER_DELAY_MS + 1);
    const atCeiling = setTimeout(() => fired.push("at the ceiling"), MAX_TIMER_DELAY_MS);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fired).toEqual(["past the ceiling"]);
    } finally {
      clearTimeout(overflowing);
      clearTimeout(atCeiling);
    }
  });

  it("is the Loop contract's ceiling under its own name, not a second copy of it", () => {
    expect(MAX_LOOP_TIMEOUT_MS).toBe(MAX_TIMER_DELAY_MS);
  });

  /**
   * The invariant this module was extracted for. The number used to be written
   * five times under four names; four of the five then contradicted a header
   * claiming "every duration that reaches a timer is bounded by this". A sixth
   * copy must fail here rather than be found by the next grep.
   */
  it("is written in exactly one source file", () => {
    const scanned = sourceRoots().flatMap(sourceFiles);
    // An empty scan would fail below anyway (no owner found); this catches the
    // subtler break where the walk still reaches one package and not the rest.
    expect(scanned.length).toBeGreaterThan(500);
    const owners = scanned
      .filter((file) => /2_147_483_647|\b2147483647\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(REPO_ROOT.length + 1));
    expect(owners).toEqual(["packages/shared/src/timers.ts"]);
  });
});
