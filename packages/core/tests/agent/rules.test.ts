import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { collectProjectRules, collectRuleFiles } from "../../src/agent/rules.js";

describe("rules-file hierarchy", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
    workspace = mkdtempSync(join(tmpdir(), "seekforge-rules-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const writeGlobal = (content: string): void => {
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    writeFileSync(join(home, ".seekforge", "AGENTS.md"), content);
  };

  it("returns undefined when no rules file exists", () => {
    expect(collectProjectRules(workspace, home)).toBeUndefined();
    expect(collectRuleFiles(workspace, home)).toEqual([]);
  });

  it("loads only the project AGENTS.md when it is the single layer", () => {
    writeFileSync(join(workspace, "AGENTS.md"), "# Project rules\nuse pnpm");
    const merged = collectProjectRules(workspace, home);
    expect(merged).toBe("<!-- from: AGENTS.md -->\n# Project rules\nuse pnpm");
  });

  it("does not load a project AGENTS.md symlink outside the workspace", () => {
    const outside = join(home, "outside-rules.md");
    writeFileSync(outside, "outside instructions");
    symlinkSync(outside, join(workspace, "AGENTS.md"));

    expect(collectRuleFiles(workspace, home)).toEqual([]);
    expect(collectProjectRules(workspace, home)).toBeUndefined();
  });

  it("does not follow a symlinked global rules parent directory", () => {
    const outside = join(workspace, "outside-config");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "AGENTS.md"), "outside instructions");
    symlinkSync(outside, join(home, ".seekforge"), "dir");

    expect(collectRuleFiles(workspace, home)).toEqual([]);
    expect(collectProjectRules(workspace, home)).toBeUndefined();
  });

  it("loads only the global AGENTS.md when present alone", () => {
    writeGlobal("global only");
    const merged = collectProjectRules(workspace, home);
    expect(merged).toBe("<!-- from: ~/.seekforge/AGENTS.md -->\nglobal only");
  });

  it("loads only AGENTS.local.md when present alone", () => {
    writeFileSync(join(workspace, "AGENTS.local.md"), "local only");
    const merged = collectProjectRules(workspace, home);
    expect(merged).toBe("<!-- from: AGENTS.local.md -->\nlocal only");
  });

  it("concatenates all three layers in global → project → local order with origin headers", () => {
    writeGlobal("be terse");
    writeFileSync(join(workspace, "AGENTS.md"), "use pnpm");
    writeFileSync(join(workspace, "AGENTS.local.md"), "my personal notes");
    const merged = collectProjectRules(workspace, home);
    expect(merged).toBe(
      [
        "<!-- from: ~/.seekforge/AGENTS.md -->\nbe terse",
        "<!-- from: AGENTS.md -->\nuse pnpm",
        "<!-- from: AGENTS.local.md -->\nmy personal notes",
      ].join("\n\n"),
    );
  });

  it("skips missing middle layers (global + local without project AGENTS.md)", () => {
    writeGlobal("be terse");
    writeFileSync(join(workspace, "AGENTS.local.md"), "personal");
    const files = collectRuleFiles(workspace, home);
    expect(files.map((f) => f.origin)).toEqual(["~/.seekforge/AGENTS.md", "AGENTS.local.md"]);
    expect(files.map((f) => f.content)).toEqual(["be terse", "personal"]);
  });

  it("treats whitespace-only files as absent; all empty → undefined", () => {
    writeGlobal("  \n\t\n");
    writeFileSync(join(workspace, "AGENTS.md"), "");
    expect(collectProjectRules(workspace, home)).toBeUndefined();

    // a single non-empty layer among empty ones still loads
    writeFileSync(join(workspace, "AGENTS.local.md"), "only me");
    expect(collectProjectRules(workspace, home)).toBe("<!-- from: AGENTS.local.md -->\nonly me");
  });

  it("skips an AGENTS.md that exceeds the per-file byte limit", () => {
    writeFileSync(join(workspace, "AGENTS.md"), "x".repeat(256 * 1024 + 1));

    expect(collectRuleFiles(workspace, home)).toEqual([]);
    expect(collectProjectRules(workspace, home)).toBeUndefined();
  });

  it("stops adding rule files when their combined content exceeds the total limit", () => {
    writeGlobal(`GLOBAL:${"g".repeat(199 * 1024)}`);
    writeFileSync(join(workspace, "AGENTS.md"), `PROJECT:${"p".repeat(199 * 1024)}`);

    const files = collectRuleFiles(workspace, home);
    expect(files.map((file) => file.origin)).toEqual(["~/.seekforge/AGENTS.md"]);
  });

  it("defaults to os.homedir() when no override is given", () => {
    // No global file under the real home is required for this assertion:
    // just verify the workspace layers load without the override parameter.
    writeFileSync(join(workspace, "AGENTS.md"), "ws rules");
    const merged = collectProjectRules(workspace);
    expect(merged).toContain("<!-- from: AGENTS.md -->\nws rules");
  });
});

// ---------------------------------------------------------------------------
// Path-scoped subdir AGENTS.md cascade.
// ---------------------------------------------------------------------------

describe("path-scoped subdir AGENTS.md", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
    workspace = mkdtempSync(join(tmpdir(), "seekforge-subrules-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const writeSubdir = (relDir: string, content: string): void => {
    mkdirSync(join(workspace, relDir), { recursive: true });
    writeFileSync(join(workspace, relDir, "AGENTS.md"), content);
  };

  it("includes a subdir AGENTS.md when the task names a path under it", () => {
    writeSubdir("packages/api", "SUBDIR-API-RULE: api conventions");
    const merged = collectProjectRules(workspace, home, "fix the bug in packages/api/src/handler.ts");
    expect(merged).toContain("SUBDIR-API-RULE: api conventions");
    expect(merged).toContain("<!-- from: packages/api/AGENTS.md -->");
  });

  it("excludes a subdir AGENTS.md when the task does not reference it", () => {
    writeSubdir("packages/api", "SUBDIR-API-RULE: api conventions");
    const merged = collectProjectRules(workspace, home, "update packages/web/src/app.ts");
    expect(merged ?? "").not.toContain("SUBDIR-API-RULE");
  });

  it("excludes all subdir rules when the task has no path tokens", () => {
    writeSubdir("packages/api", "SUBDIR-API-RULE: api conventions");
    const merged = collectProjectRules(workspace, home, "make the code faster");
    expect(merged ?? "").not.toContain("SUBDIR-API-RULE");
  });

  it("excludes subdir rules when no task is passed (back-compat)", () => {
    writeSubdir("packages/api", "SUBDIR-API-RULE: api conventions");
    writeFileSync(join(workspace, "AGENTS.md"), "root rules");
    const merged = collectProjectRules(workspace, home);
    expect(merged).toContain("root rules");
    expect(merged ?? "").not.toContain("SUBDIR-API-RULE");
  });

  it("keeps global/project/local merging unchanged alongside a matched subdir", () => {
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    writeFileSync(join(home, ".seekforge", "AGENTS.md"), "be terse");
    writeFileSync(join(workspace, "AGENTS.md"), "use pnpm");
    writeFileSync(join(workspace, "AGENTS.local.md"), "personal");
    writeSubdir("packages/api", "api rules");

    const merged = collectProjectRules(workspace, home, "edit packages/api/index.ts")!;
    // Global → project → local appear first and in order; subdir is appended last.
    expect(merged.indexOf("be terse")).toBeLessThan(merged.indexOf("use pnpm"));
    expect(merged.indexOf("use pnpm")).toBeLessThan(merged.indexOf("personal"));
    expect(merged.indexOf("personal")).toBeLessThan(merged.indexOf("api rules"));
  });

  it("does not scan into node_modules", () => {
    // A planted AGENTS.md under node_modules must never be included, even when
    // the task path token would otherwise match.
    writeSubdir("node_modules/some-pkg", "NODE-MODULES-RULE: should never load");
    const merged = collectProjectRules(workspace, home, "look at node_modules/some-pkg/index.js");
    expect(merged ?? "").not.toContain("NODE-MODULES-RULE");
  });
});

// ---------------------------------------------------------------------------
// Loop integration: global + local rules content reaches the system prompt.
// ---------------------------------------------------------------------------

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function fakeProvider(script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async () => ({ ok: true }),
};

async function drain(events: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const _ of events) {
    // consume
  }
}

describe("agent loop rules integration", () => {
  let home: string;
  let workspace: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-rules-"));
    savedHome = process.env["HOME"];
    process.env["HOME"] = home; // os.homedir() honors $HOME on POSIX
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("system prompt contains global, project, and local rules content", async () => {
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    writeFileSync(join(home, ".seekforge", "AGENTS.md"), "GLOBAL-RULE-MARKER: be terse");
    writeFileSync(join(workspace, "AGENTS.md"), "PROJECT-RULE-MARKER: use pnpm");
    writeFileSync(join(workspace, "AGENTS.local.md"), "LOCAL-RULE-MARKER: my machine");

    const provider = fakeProvider([{ content: "done", toolCalls: [], usage: USAGE, finishReason: "stop" }]);
    const agent = createAgentCore({
      provider,
      dispatcher: noopDispatcher,
      confirm: async () => true,
    });
    await drain(agent.runTask({ projectPath: workspace, task: "t", mode: "edit", approvalMode: "auto" }));

    const system = provider.requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("GLOBAL-RULE-MARKER: be terse");
    expect(system.content).toContain("PROJECT-RULE-MARKER: use pnpm");
    expect(system.content).toContain("LOCAL-RULE-MARKER: my machine");
    expect(system.content).toContain("<!-- from: ~/.seekforge/AGENTS.md -->");
    expect(system.content).toContain("<!-- from: AGENTS.local.md -->");
  });
});
