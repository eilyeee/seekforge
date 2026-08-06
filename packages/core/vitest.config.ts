import { defineConfig } from "vitest/config";

/**
 * Test timeouts for @seekforge/core.
 *
 * These lived only in the package's `test` script (`--testTimeout=30000
 * --hookTimeout=60000`), which meant CI and a developer disagreed: `pnpm test`
 * got 30s, `npx vitest run tests/agent/graph-engineering.test.ts` — the thing
 * you actually type while debugging one file — got Vitest's 5s default. On a
 * loaded machine that gap failed 14 different suites, none of which had
 * anything wrong with them.
 *
 * The number is not arbitrary. This package's durable engine writes a
 * checkpoint per state transition, each an atomic write costing two fsyncs
 * (~40ms apiece on a typical dev filesystem), so a single-node graph run
 * performs 9 such writes and a test that runs a graph twice with a retry
 * legitimately takes 3-8 seconds. 30s is headroom over that, not cover for a
 * hang: a core test that takes 30s has something genuinely wrong with it.
 *
 * The package script keeps its flags — they now agree with this file rather
 * than contradicting it — so nothing depends on which entry point you use.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
