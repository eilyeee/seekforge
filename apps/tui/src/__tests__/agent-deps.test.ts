import { describe, expect, it } from "vitest";
import { asAdaptiveToolDispatcher, createUsageBus, loadMcpToolSpecs, type PluginContributions } from "@seekforge/core";
import { buildTuiDeps, tuiHooks } from "../agent/factory.js";
import type { TuiConfig } from "../config.js";

const emptyContributions = (): PluginContributions => ({
  skillRoots: [],
  agentRoots: [],
  mcpServers: {},
  hooks: {},
  plugins: [],
});

// Contract: TUI config -> AgentCoreDeps passthrough (its own mapping, separate
// from the CLI's). Guards the cross-entry params that have dropped before.
const base = { apiKey: "sk-test", model: "deepseek-v4-flash" } as TuiConfig;
const deps = (config: TuiConfig) => buildTuiDeps({ config, confirm: async () => true, extractMemory: false }).deps;

describe("buildTuiDeps (config -> deps contract)", () => {
  it("sandbox passes through; 'off' is dropped", () => {
    expect(deps({ ...base, sandbox: "restricted" } as TuiConfig).sandbox).toBe("restricted");
    expect(deps({ ...base, sandbox: "off" } as TuiConfig).sandbox).toBeUndefined();
    expect(deps(base).sandbox).toBeUndefined();
  });

  it("planModel uses config.planModel, falling back to routing.planModel", () => {
    expect(deps({ ...base, planModel: "deepseek-v4-pro" } as TuiConfig).planModel).toBe("deepseek-v4-pro");
    expect(deps({ ...base, routing: { planModel: "deepseek-v4-pro" } } as TuiConfig).planModel).toBe("deepseek-v4-pro");
    expect(deps(base).planModel).toBeUndefined();
  });

  it("compaction / escalateOnFailure / commandAllowlist / hooks / permissionRules pass through", () => {
    const hooks = { preToolUse: [{ command: "echo hi" }] };
    const rules = [{ action: "deny" as const, tool: "run_command" }];
    const d = deps({
      ...base,
      compaction: "llm",
      escalateOnFailure: true,
      commandAllowlist: ["pnpm"],
      hooks,
      permissionRules: rules,
    } as TuiConfig);
    expect(d.compaction).toBe("llm");
    expect(d.escalateOnFailure).toBe(true);
    expect(d.commandAllowlist).toEqual(["pnpm"]);
    expect(d.hooks).toEqual(hooks);
    expect(d.permissionRules).toEqual(rules);
  });

  it("context-window settings pass through", () => {
    const d = deps({
      ...base,
      autoCompactThreshold: 0.8,
      modelContextWindows: { "local-model": 32_768 },
    } as TuiConfig);
    expect(d.autoCompactThreshold).toBe(0.8);
    expect(d.modelContextWindows).toEqual({ "local-model": 32_768 });
    expect("modelContextWindows" in deps(base)).toBe(false);
  });

  it("joins the session's --add-dir / /add-dir directories to the config's additionalDirectories", () => {
    const build = (config: TuiConfig, extraDirectories?: string[]) =>
      buildTuiDeps({
        config,
        confirm: async () => true,
        extractMemory: false,
        ...(extraDirectories ? { extraDirectories } : {}),
      }).deps.additionalDirectories;
    expect(build({ ...base, additionalDirectories: ["/cfg", "/both"] }, ["/both", "/session"])).toEqual([
      "/cfg",
      "/both",
      "/session",
    ]);
    expect(build(base, ["/session"])).toEqual(["/session"]);
    expect(build({ ...base, additionalDirectories: ["/cfg"] })).toEqual(["/cfg"]);
    expect(build(base, [])).toBeUndefined();
  });

  it("builds the run's dispatcher over the MCP registry, never with its tools registered twice", async () => {
    const { registry, dispose } = await loadMcpToolSpecs({}, undefined, undefined, undefined, {});
    try {
      const withMcp = buildTuiDeps({
        config: base,
        confirm: async () => true,
        extractMemory: false,
        mcpRegistry: registry,
      }).deps.dispatcher;
      expect(asAdaptiveToolDispatcher(withMcp)).toBeDefined();
      const names = withMcp.list().map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      // Without a registry the run gets the plain built-in catalog.
      expect(asAdaptiveToolDispatcher(deps(base).dispatcher)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("merges plugin hooks into the config's, for runs and /compact alike", () => {
    const hooks = { preCompact: [{ command: "echo mine" }] };
    const pluginHooks = { preCompact: [{ command: "echo plugin" }] };
    const contributions = { ...emptyContributions(), hooks: pluginHooks };
    const merged = tuiHooks({ hooks }, "/abs/ws", contributions as never);
    expect(merged?.preCompact?.map((entry) => ("command" in entry ? entry.command : ""))).toEqual([
      "echo plugin",
      "echo mine",
    ]);
    const d = buildTuiDeps({
      config: { ...base, hooks },
      workspace: "/abs/ws",
      pluginContributions: contributions as never,
      confirm: async () => true,
      extractMemory: false,
    }).deps;
    expect(d.hooks).toEqual(merged);
  });

  it("forwards the usage bus, so an MCP server's sampling is counted", () => {
    // It travels through a conditional spread, where TypeScript's
    // excess-property check cannot catch a dropped key.
    const usageBus = createUsageBus();
    const withBus = buildTuiDeps({ config: base, confirm: async () => true, extractMemory: false, usageBus }).deps;
    expect(withBus.usageBus).toBe(usageBus);
    expect(deps(base).usageBus).toBeUndefined();
  });
});
