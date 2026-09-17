import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapAgentToolList, parseAgentHooks } from "../../src/subagents/fields.js";
import { parseFrontmatter } from "../../src/subagents/frontmatter.js";
import { importExternalAgent, parseExternalAgent, renderAgentMarkdown } from "../../src/subagents/import.js";
import { loadAgentDefinitions, parseAgentMarkdown } from "../../src/subagents/load.js";

const EXTENDED = `---
name: fixer
description: fixes things
tools:
  - read_file
  - write_file
  - run_command
disallowedTools: [run_command]
permissionMode: acceptEdits
isolation: worktree
skills: [bugfix, not a valid id, bugfix]
effort: max
color: Purple
mcpServers:
  - github
  - inline: {command: npx}
hooks:
  preToolUse:
    - match: write_file
      command: ./lint-staged.sh
  sessionStart:
    - command: ./never.sh
---
Fix it.
`;

describe("parseAgentMarkdown — Claude Code fields", () => {
  it("parses lists and the extended fields for a global agent", () => {
    const def = parseAgentMarkdown("global", "fixer", EXTENDED);
    expect(def.tools).toEqual(["read_file", "write_file", "run_command"]);
    expect(def.disallowedTools).toEqual(["run_command"]);
    expect(def.permissionMode).toBe("acceptEdits");
    expect(def.isolation).toBe("worktree");
    expect(def.skills).toEqual(["bugfix"]);
    expect(def.effort).toBe("max");
    expect(def.color).toBe("purple");
    // Inline server definitions are never honored — references only.
    expect(def.mcpServers).toEqual(["github"]);
    // Stages that never fire in a nested run are dropped.
    expect(def.hooks).toEqual({ preToolUse: [{ match: "write_file", command: "./lint-staged.sh" }] });
  });

  it("drops hooks from a project (repository-controlled) agent", () => {
    const def = parseAgentMarkdown("project", "fixer", EXTENDED);
    expect(def.hooks).toBeUndefined();
    // Everything else still parses; policy.ts decides what a project agent may use.
    expect(def.permissionMode).toBe("acceptEdits");
  });

  it("maps permission-mode aliases and makes plan read-only", () => {
    const md = (mode: string) => `---\nname: a\nmode: edit\npermissionMode: ${mode}\n---\n`;
    expect(parseAgentMarkdown("global", "a", md("bypassPermissions")).permissionMode).toBe("bypassPermissions");
    expect(parseAgentMarkdown("global", "a", md("auto")).permissionMode).toBe("bypassPermissions");
    expect(parseAgentMarkdown("global", "a", md("confirm")).permissionMode).toBe("default");
    expect(parseAgentMarkdown("global", "a", md("dontAsk")).permissionMode).toBe("dontAsk");
    const plan = parseAgentMarkdown("global", "a", md("plan"));
    expect(plan.permissionMode).toBe("plan");
    expect(plan.mode).toBe("ask");
  });

  it("rejects unknown permission modes and isolation values instead of running looser", () => {
    expect(() => parseAgentMarkdown("global", "a", "---\nname: a\npermissionMode: yolo\n---\n")).toThrow(
      /permissionMode/,
    );
    expect(() => parseAgentMarkdown("global", "a", "---\nname: a\nisolation: worktre\n---\n")).toThrow(/isolation/);
    expect(parseAgentMarkdown("global", "a", "---\nname: a\nisolation: none\n---\n").isolation).toBeUndefined();
  });

  it("ignores unknown efforts and colors that are not in the closed set", () => {
    const def = parseAgentMarkdown("global", "a", '---\nname: a\neffort: extreme\ncolor: "\\u001b[31m"\n---\n');
    expect(def.effort).toBeUndefined();
    expect(def.color).toBeUndefined();
    expect(parseAgentMarkdown("global", "a", "---\nname: a\ncolor: '#A1b2C3'\n---\n").color).toBe("#a1b2c3");
    expect(parseAgentMarkdown("global", "a", "---\nname: a\neffort: xhigh\n---\n").effort).toBe("max");
  });

  it("accepts a YAML trigger list and Claude's maxTurns spelling", () => {
    const def = parseAgentMarkdown("project", "a", "---\nname: a\ntrigger:\n  - review\n  - audit\nmaxTurns: 4\n---\n");
    expect(def.triggers).toEqual(["review", "audit"]);
    expect(def.maxTurns).toBe(4);
  });
});

describe("tool-name mapping", () => {
  it("maps Claude Code tools to today's SeekForge names", () => {
    const { tools, dropped } = mapAgentToolList([
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "LS",
      "Bash",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
      "TodoWrite",
      "mcp__github__create_issue",
      "search_text",
      "Task",
      "Bash(git status:*)",
    ]);
    expect(tools).toEqual([
      "read_file",
      "write_file",
      "apply_patch",
      "glob",
      "search_text",
      "list_files",
      "run_command",
      "web_fetch",
      "web_search",
      "notebook_edit",
      "update_plan",
      "mcp__github__create_issue",
    ]);
    // A scoped specifier is dropped rather than widened to the whole tool.
    expect(dropped).toEqual(["Task", "Bash(git status:*)"]);
  });

  it("expands LSP to the lsp_* tools", () => {
    const { tools } = mapAgentToolList(["LSP"]);
    expect(tools).toContain("lsp_definition");
    expect(tools).toContain("lsp_references");
    expect(tools.every((name) => name.startsWith("lsp_"))).toBe(true);
  });
});

describe("parseAgentHooks", () => {
  it("maps Claude matchers exactly and skips regex matchers it cannot map", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "hooks:",
        "  PreToolUse:",
        '    - matcher: "Edit|Write"',
        "      hooks:",
        "        - type: command",
        "          command: ./fmt.sh",
        '    - matcher: "Bash.*"',
        "      hooks:",
        "        - type: command",
        "          command: ./never.sh",
        "    - hooks:",
        "        - type: prompt",
        "          prompt: ignored",
        "        - command: ./any.sh",
        "  SubagentStop:",
        "    - command: ./done.sh",
        "---",
        "",
      ].join("\n"),
    );
    expect(parseAgentHooks(parsed.values.get("hooks"))).toEqual({
      preToolUse: [
        { match: "apply_patch", command: "./fmt.sh" },
        { match: "write_file", command: "./fmt.sh" },
        { command: "./any.sh" },
      ],
      subagentStop: [{ command: "./done.sh" }],
    });
  });

  it("returns undefined for non-map values", () => {
    expect(parseAgentHooks(undefined)).toBeUndefined();
    expect(parseAgentHooks("hooks")).toBeUndefined();
    expect(parseAgentHooks(["a"])).toBeUndefined();
  });
});

const CLAUDE_AGENT = `---
name: code-reviewer
description: Reviews code
tools: Read, Grep, Glob
model: sonnet
permissionMode: plan
color: blue
hooks:
  PreToolUse:
    - matcher: Read
      hooks:
        - type: command
          command: ./audit.sh
---
You review code.
`;

describe("parseExternalAgent — Claude Code files", () => {
  it("maps fields, drops Claude model aliases, and makes plan agents read-only", () => {
    const { def } = parseExternalAgent(CLAUDE_AGENT);
    expect(def.id).toBe("code-reviewer");
    expect(def.tools).toEqual(["read_file", "search_text", "glob"]);
    expect(def.model).toBeUndefined();
    expect(def.mode).toBe("ask");
    expect(def.color).toBe("blue");
    expect(def.hooks?.preToolUse).toEqual([{ match: "read_file", command: "./audit.sh" }]);
    expect(def.body).toBe("You review code.");
  });

  it("falls back to the file stem when the name is missing", () => {
    const { def } = parseExternalAgent("---\ndescription: d\n---\nbody", { fallbackName: "My_Helper" });
    expect(def.id).toBe("my-helper");
    expect(() => parseExternalAgent("---\ndescription: d\n---\nbody")).toThrow(/name/);
  });

  it("round-trips the extended fields through renderAgentMarkdown", () => {
    const { def } = parseExternalAgent(EXTENDED.replace("name: fixer", "name: fixer"));
    const rendered = renderAgentMarkdown(def);
    const back = parseAgentMarkdown("global", def.id, rendered);
    expect(back.disallowedTools).toEqual(def.disallowedTools);
    expect(back.permissionMode).toBe(def.permissionMode);
    expect(back.isolation).toBe("worktree");
    expect(back.skills).toEqual(def.skills);
    expect(back.effort).toBe("max");
    expect(back.color).toBe("purple");
    expect(back.mcpServers).toEqual(["github"]);
    expect(back.hooks).toEqual(def.hooks);
  });
});

describe("importExternalAgent — an import only tightens", () => {
  let src: string;
  let target: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "sf-agent-src-"));
    target = mkdtempSync(join(tmpdir(), "sf-agent-dst-"));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("drops hooks and a looser-than-default permission mode", () => {
    const file = join(src, "fixer.md");
    writeFileSync(file, EXTENDED.replace("permissionMode: acceptEdits", "permissionMode: bypassPermissions"));
    const imported = importExternalAgent(file, { targetRoot: target });
    expect(imported.droppedFields).toEqual(["hooks", "permissionMode"]);
    const written = readFileSync(join(target, "fixer", "AGENT.md"), "utf8");
    expect(written).not.toContain("hooks:");
    expect(written).not.toContain("permissionMode");
    expect(written).toContain('isolation: "worktree"');
  });

  it("keeps a tightening permission mode", () => {
    const file = join(src, "reviewer.md");
    writeFileSync(file, CLAUDE_AGENT);
    const imported = importExternalAgent(file, { targetRoot: target });
    expect(imported.droppedFields).toEqual(["hooks"]);
    expect(imported.agent.permissionMode).toBe("plan");
  });
});

describe("loadAgentDefinitions — .claude/agents", () => {
  let home: string;
  let workspace: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sf-home-"));
    workspace = mkdtempSync(join(tmpdir(), "sf-ws-"));
    savedHome = process.env.SEEKFORGE_HOME;
    process.env.SEEKFORGE_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
    else process.env.SEEKFORGE_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const noPlugins = { skillRoots: [], agentRoots: [], mcpServers: {}, hooks: {}, plugins: [] };

  it("loads user and project Claude agents under their scopes; hooks only for the user's", () => {
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "agents", "user-reviewer.md"),
      CLAUDE_AGENT.replace("code-reviewer", "user-reviewer"),
    );
    mkdirSync(join(workspace, ".claude", "agents"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "agents", "code-reviewer.md"), CLAUDE_AGENT);
    writeFileSync(join(workspace, ".claude", "agents", "notes.txt"), "ignored");

    const defs = loadAgentDefinitions(workspace, noPlugins);
    const user = defs.find((d) => d.id === "user-reviewer")!;
    const project = defs.find((d) => d.id === "code-reviewer")!;
    expect(user.scope).toBe("global");
    expect(user.hooks?.preToolUse).toHaveLength(1);
    expect(project.scope).toBe("project");
    expect(project.hooks).toBeUndefined();
    expect(project.tools).toEqual(["read_file", "search_text", "glob"]);
  });

  it("lets a SeekForge definition win over a Claude file with the same id", () => {
    mkdirSync(join(workspace, ".claude", "agents"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "agents", "code-reviewer.md"), CLAUDE_AGENT);
    mkdirSync(join(workspace, ".seekforge", "agents", "code-reviewer"), { recursive: true });
    writeFileSync(
      join(workspace, ".seekforge", "agents", "code-reviewer", "AGENT.md"),
      "---\nname: SeekForge reviewer\nmode: ask\n---\nours",
    );
    const def = loadAgentDefinitions(workspace, noPlugins).find((d) => d.id === "code-reviewer")!;
    expect(def.name).toBe("SeekForge reviewer");
    expect(def.body).toBe("ours");
  });

  it("does not follow a symlinked agent file", () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-outside-"));
    try {
      writeFileSync(join(outside, "evil.md"), CLAUDE_AGENT.replace("code-reviewer", "evil"));
      mkdirSync(join(workspace, ".claude", "agents"), { recursive: true });
      symlinkSync(join(outside, "evil.md"), join(workspace, ".claude", "agents", "evil.md"));
      expect(loadAgentDefinitions(workspace, noPlugins).some((d) => d.id === "evil")).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
