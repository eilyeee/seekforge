import { defineConfig } from "vitest/config";

/**
 * Test timeouts for the CLI — the third package to need this, for the third
 * time for the same reason (see `packages/core` and `apps/server`).
 *
 * This one had neither a config nor a flag on its `test` script, so every suite
 * ran on Vitest's 5s default. That is not enough for the tests that exercise
 * real git: `resolve` and `resolve-review` each `git init` a repository, add a
 * worktree, and then spawn `git check-ignore` per seeded path — a dozen
 * subprocesses, every one of them a fork+exec. On an idle machine they finish
 * in about a second; with the other six packages running in parallel under
 * `pnpm test` they do not, and the failure reads as a broken command rather
 * than as a starved one.
 *
 * 15s is headroom over the observed worst case, not cover for a hang: nothing
 * here talks to a provider or waits on a lease, so a CLI test that takes 15s
 * has something genuinely wrong with it.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
