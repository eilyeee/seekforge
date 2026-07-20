import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyCommand } from "../../src/tools/run-command.js";

// Shared TS<->Rust command-policy parity fixture. The Rust runtime asserts the
// exact same file in its `command_policy_parity_fixture` test. If the two
// backends' denylists (or reason strings) ever drift, one of these two tests
// fails — which is the whole point: the denylist is hand-mirrored across
// languages and must never silently diverge (a plain `git push` denied by one
// backend but confirmed by the other is exactly the bug this guards).
const fixtureUrl = new URL("../../../../test-fixtures/command-policy.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  cases: Array<{ command: string; reason: string | null }>;
};

describe("TS<->Rust command-policy parity", () => {
  it("classifies every fixture case with the same deny decision as the Rust runtime", () => {
    for (const { command, reason } of fixture.cases) {
      const c = classifyCommand(command);
      const denied = c.permission === "dangerous";
      if (reason === null) {
        expect(denied, `expected NOT denied: ${command}`).toBe(false);
      } else {
        expect(denied, `expected denied: ${command}`).toBe(true);
        expect(c.reason, `deny reason mismatch: ${command}`).toBe(reason);
      }
    }
  });
});
