import { defineConfig } from "vitest/config";

/**
 * Test timeouts for @seekforge/server — the same fix packages/core already
 * carries, for the same reason.
 *
 * The timeout lived only in the package's `test` script
 * (`vitest run --testTimeout=15000`), so `pnpm test` got 15s and
 * `npx vitest run tests/rest.test.ts` — the thing you type while debugging one
 * file — got Vitest's 5s default. Two of the Engineering Graph REST tests take
 * 3.2s and 2.6s on an idle machine, because they drive a real durable graph run
 * whose every state transition is an atomic write costing two fsyncs. Under the
 * default they failed as "timed out", which reads as a bug in the server and is
 * not one; under any parallel load they failed reliably.
 *
 * The script keeps its flag — it now agrees with this file instead of
 * contradicting it — so the number no longer depends on how you invoke Vitest.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
