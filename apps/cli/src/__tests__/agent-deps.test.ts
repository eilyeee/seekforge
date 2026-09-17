import { asAdaptiveToolDispatcher, createDispatchManager, createUsageBus, loadMcpToolSpecs } from "@seekforge/core";
// Contract test: CLI config -> AgentCoreDeps passthrough. Guards the cross-entry
// parameters (sandbox, permission, planModel, compaction, hooks, limits) that
// have silently dropped before.

import assert from "node:assert/strict";
import { test } from "vitest";
import { createCliAgentDeps, mcpToolSearchThresholdProblem, mergeAdditionalDirectories } from "../agent-factory.js";
import type { CliConfig } from "../config.js";

const base: CliConfig = { apiKey: "sk-test", model: "deepseek-v4-flash" };
const deps = (config: CliConfig, extra: Partial<Parameters<typeof createCliAgentDeps>[0]> = {}) =>
  createCliAgentDeps({ config, confirm: async () => true, extractMemory: false, ...extra }).deps;

test("sandbox passes through (and 'off' is dropped)", () => {
  assert.equal(deps({ ...base, sandbox: "restricted" }).sandbox, "restricted");
  assert.equal(deps({ ...base, sandbox: "off" }).sandbox, undefined);
  assert.equal(deps(base).sandbox, undefined);
});

test("context-window settings pass through", () => {
  const d = deps({ ...base, autoCompactThreshold: 0.8, modelContextWindows: { "local-model": 32_768 } });
  assert.equal(d.autoCompactThreshold, 0.8);
  assert.deepEqual(d.modelContextWindows, { "local-model": 32_768 });
  assert.equal("autoCompactThreshold" in deps(base), false);
});

test("planModel / compaction / escalation / memory settings pass through", () => {
  const d = deps({
    ...base,
    planModel: "deepseek-v4-pro",
    compaction: "llm",
    escalateOnFailure: true,
    memoryAutoApproveConfidence: 0.8,
    memoryMaintenance: { enabled: true, minFacts: 25, minIntervalHours: 12 },
  });
  assert.equal(d.planModel, "deepseek-v4-pro");
  assert.equal(d.compaction, "llm");
  assert.equal(d.escalateOnFailure, true);
  assert.equal(d.memoryAutoApproveConfidence, 0.8);
  assert.deepEqual(d.memoryMaintenance, {
    enabled: true,
    minFacts: 25,
    minBytes: 64 * 1024,
    minIntervalHours: 12,
  });
  // Defaults: absent when not configured.
  const bare = deps(base);
  assert.equal(bare.planModel, undefined);
  assert.equal(bare.escalateOnFailure, undefined);
  assert.equal(bare.memoryMaintenance, undefined);
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

test("usageBus reaches the agent, so an MCP server's sampling is counted", () => {
  // Passing it through a conditional spread means TypeScript's excess-property
  // check cannot catch a dropped key; assert the object actually arrives.
  const usageBus = createUsageBus();
  assert.equal(deps(base, { usageBus }).usageBus, usageBus);
  assert.equal(deps(base).usageBus, undefined);
});

test("--add-dir directories join config.additionalDirectories, each once", () => {
  assert.deepEqual(
    deps({ ...base, additionalDirectories: ["/a", "/b"] }, { additionalDirectories: ["/b", "/c"] })
      .additionalDirectories,
    ["/a", "/b", "/c"],
  );
  assert.deepEqual(deps(base, { additionalDirectories: ["/c"] }).additionalDirectories, ["/c"]);
  assert.equal(deps(base, { additionalDirectories: [] }).additionalDirectories, undefined);
  assert.equal(mergeAdditionalDirectories(undefined, undefined), undefined);
});

test("a session-scoped subagent manager reaches the agent", () => {
  const manager = createDispatchManager({ sessionScoped: true });
  assert.equal(deps(base, { dispatchManager: manager }).dispatchManager, manager);
  assert.equal(deps(base).dispatchManager, undefined);
});

test("an MCP registry makes the dispatcher adaptive; without one it is the fixed default", async () => {
  // A registry whose only server may not connect: no child process starts.
  const loaded = await loadMcpToolSpecs({ off: { command: "never-started" } }, undefined, undefined, undefined, {
    origins: { off: "user" },
  });
  try {
    const adaptive = deps(base, { mcpRegistry: loaded.registry, mcpToolSpecs: loaded.specs }).dispatcher;
    assert.ok(asAdaptiveToolDispatcher(adaptive));
    assert.ok(adaptive.list().some((tool) => tool.name === "read_file"));
    assert.equal(asAdaptiveToolDispatcher(deps(base).dispatcher), undefined);
  } finally {
    loaded.dispose();
  }
});

test("mcpToolSearchThresholdProblem checks the range only when servers are configured", () => {
  const servers = { mcpServers: { a: { command: "a" } } };
  assert.equal(mcpToolSearchThresholdProblem({ ...base, ...servers, mcpToolSearchThreshold: 0 }), undefined);
  assert.equal(mcpToolSearchThresholdProblem({ ...base, ...servers, mcpToolSearchThreshold: 100 }), undefined);
  assert.match(
    mcpToolSearchThresholdProblem({ ...base, ...servers, mcpToolSearchThreshold: 101 }) ?? "",
    /from 0 to 100/,
  );
  assert.match(
    mcpToolSearchThresholdProblem({ ...base, ...servers, mcpToolSearchThreshold: "5" as unknown as number }) ?? "",
    /from 0 to 100/,
  );
  assert.equal(mcpToolSearchThresholdProblem({ ...base, mcpToolSearchThreshold: 101 }), undefined);
});
