// Contract test: CLI config -> AgentCoreDeps passthrough. Guards the cross-entry
// parameters (sandbox, permission, planModel, compaction, hooks, limits) that
// have silently dropped before. tsx/node:assert runner, like the other tests.

import assert from "node:assert/strict";
import { createCliAgentDeps } from "../agent-factory.js";
import type { CliConfig } from "../config.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

const base: CliConfig = { apiKey: "sk-test", model: "deepseek-v4-flash" };
const deps = (config: CliConfig, extra: Partial<Parameters<typeof createCliAgentDeps>[0]> = {}) =>
  createCliAgentDeps({ config, confirm: async () => true, extractMemory: false, ...extra }).deps;

test("sandbox passes through (and 'off' is dropped)", () => {
  assert.equal(deps({ ...base, sandbox: "restricted" }).sandbox, "restricted");
  assert.equal(deps({ ...base, sandbox: "off" }).sandbox, undefined);
  assert.equal(deps(base).sandbox, undefined);
});

test("planModel / compaction / escalateOnFailure / memoryAutoApproveConfidence pass through", () => {
  const d = deps({
    ...base,
    planModel: "deepseek-v4-pro",
    compaction: "llm",
    escalateOnFailure: true,
    memoryAutoApproveConfidence: 0.8,
  });
  assert.equal(d.planModel, "deepseek-v4-pro");
  assert.equal(d.compaction, "llm");
  assert.equal(d.escalateOnFailure, true);
  assert.equal(d.memoryAutoApproveConfidence, 0.8);
  // Defaults: absent when not configured.
  const bare = deps(base);
  assert.equal(bare.planModel, undefined);
  assert.equal(bare.escalateOnFailure, undefined);
});

test("commandAllowlist and hooks pass through", () => {
  const hooks = { preToolUse: [{ command: "echo hi" }] };
  const d = deps({ ...base, commandAllowlist: ["pnpm"], hooks });
  assert.deepEqual(d.commandAllowlist, ["pnpm"]);
  assert.deepEqual(d.hooks, hooks);
});

test("permissionRules: config used by default, opts override wins", () => {
  const configRules = [{ action: "deny" as const, tool: "run_command" }];
  const optRules = [{ action: "allow" as const, tool: "run_command" }];
  assert.deepEqual(deps({ ...base, permissionRules: configRules }).permissionRules, configRules);
  assert.deepEqual(
    deps({ ...base, permissionRules: configRules }, { permissionRules: optRules }).permissionRules,
    optRules,
  );
});

test("maxTurns opt becomes limits.maxAgentTurns (and only when > 0)", () => {
  assert.equal(deps(base, { maxTurns: 12 }).limits?.maxAgentTurns, 12);
  assert.equal(deps(base, { maxTurns: 0 }).limits, undefined);
  assert.equal(deps(base).limits, undefined);
});

console.log(`${passed} agent-deps contract tests passed`);
