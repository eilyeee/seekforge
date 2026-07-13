/**
 * P1 regression guard: a user's deny/allow permissionRules in
 * .seekforge/config.json must reach the agent on the server (desktop/web)
 * path, exactly as they do on the CLI. Previously the server dropped them.
 *
 * Two layers are checked:
 *  1. loadConfig concatenates project-then-global rules (first match wins).
 *  2. createDefaultAgent forwards the merged rules into createAgentCore.
 *
 * HOME is redirected to a throwaway dir so the real ~/.seekforge/config.json
 * can never bleed into these assertions.
 */

import type { PermissionRule } from "@seekforge/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the deps handed to createAgentCore; stub the rest of core so no real
// provider / network is built. The factory only needs `runTask` to exist.
const captured: { deps?: Record<string, unknown> } = {};
vi.mock("@seekforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seekforge/core")>();
  return {
    ...actual,
    createAgentCore: (deps: Record<string, unknown>) => {
      captured.deps = deps;
      return { runTask: async function* () {} };
    },
    createDeepSeekProvider: () => ({}),
    createDefaultDispatcher: () => ({}),
    createRetryBus: () => ({ onRetry: () => {} }),
    createRuntimeClient: () => ({ dispose: () => {} }),
  };
});

const { loadConfig } = await import("../src/config.js");
const { createDefaultAgent } = await import("../src/agent.js");
const { makeWorkspace, writeFileIn } = await import("./helpers.js");

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env["HOME"];
  home = makeWorkspace();
  process.env["HOME"] = home;
  captured.deps = undefined;
});

afterEach(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
});

const projectRule: PermissionRule = { action: "deny", tool: "run_command", match: "rm" };
const globalRule: PermissionRule = { action: "allow", tool: "read_file" };

describe("loadConfig permissionRules merge", () => {
  it("concatenates project-then-global rules (project first => higher precedence)", () => {
    const workspace = makeWorkspace();
    writeFileIn(home, ".seekforge/config.json", JSON.stringify({ permissionRules: [globalRule] }));
    writeFileIn(workspace, ".seekforge/config.json", JSON.stringify({ permissionRules: [projectRule] }));

    const config = loadConfig(workspace);
    // Project rules come first so a project deny is scanned before any global rule.
    expect(config.permissionRules).toEqual([projectRule, globalRule]);
  });

  it("omits permissionRules entirely when neither layer defines any", () => {
    const workspace = makeWorkspace();
    writeFileIn(workspace, ".seekforge/config.json", JSON.stringify({ model: "deepseek-v4-flash" }));

    expect(loadConfig(workspace).permissionRules).toBeUndefined();
  });

  it("treats a non-object JSON root as an empty config layer", () => {
    const workspace = makeWorkspace();
    writeFileIn(workspace, ".seekforge/config.json", "null");

    expect(loadConfig(workspace)).toEqual({});
  });
});

describe("createDefaultAgent permissionRules pass-through", () => {
  it("forwards configured permissionRules into createAgentCore", () => {
    const workspace = makeWorkspace();
    writeFileIn(home, ".seekforge/config.json", JSON.stringify({ permissionRules: [globalRule] }));
    writeFileIn(
      workspace,
      ".seekforge/config.json",
      JSON.stringify({ apiKey: "sk-test", permissionRules: [projectRule] }),
    );

    createDefaultAgent({
      workspace,
      confirm: async () => ({ allow: true }),
      extractMemory: false,
    });

    expect(captured.deps?.["permissionRules"]).toEqual([projectRule, globalRule]);
  });

  it("does not set permissionRules when none are configured", () => {
    const workspace = makeWorkspace();
    writeFileIn(workspace, ".seekforge/config.json", JSON.stringify({ apiKey: "sk-test" }));

    createDefaultAgent({
      workspace,
      confirm: async () => ({ allow: true }),
      extractMemory: false,
    });

    expect(captured.deps).toBeDefined();
    expect("permissionRules" in (captured.deps ?? {})).toBe(false);
  });
});
