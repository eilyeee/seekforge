import { describe, expect, it } from "vitest";
import { buildTuiDeps } from "../agent/factory.js";
import type { TuiConfig } from "../config.js";

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
});
