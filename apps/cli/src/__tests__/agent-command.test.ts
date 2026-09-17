// `seekforge agent show` prints every definition field a run honors, and
// `agent import` says which fields an import never carries.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDefinitionFieldLines, agentImportCommand, agentShowCommand } from "../commands/agent.js";

let cwd: string;
let home: string;
let out: string[];
const previousHome = process.env["SEEKFORGE_HOME"];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-agent-cmd-"));
  home = mkdtempSync(join(tmpdir(), "sf-agent-home-"));
  process.env["SEEKFORGE_HOME"] = home;
  vi.stubEnv("HOME", home);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  if (previousHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = previousHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const EXTERNAL = `---
name: fixer
description: fixes things
tools: Read, Edit, Bash
disallowedTools: WebFetch
permissionMode: bypassPermissions
isolation: worktree
skills: [bugfix]
effort: high
color: green
mcpServers: [github]
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./gate.sh
---
Fix it.
`;

describe("agent show", () => {
  it("prints the extended fields of a definition", () => {
    const dir = join(cwd, ".seekforge", "agents", "fixer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "AGENT.md"),
      [
        "---",
        "name: fixer",
        "description: fixes",
        "tools: read_file",
        "disallowedTools: run_command",
        "permissionMode: plan",
        "isolation: worktree",
        "skills: bugfix, lint",
        "effort: low",
        "color: red",
        "mcpServers: github",
        "---",
        "body",
      ].join("\n"),
    );
    agentShowCommand("fixer");
    const text = out.join("\n");
    expect(text).toContain("# fixer [project] [ask]");
    expect(text).toContain("disallowed:  run_command");
    expect(text).toContain("permission:  plan");
    expect(text).toContain("isolation:   worktree");
    expect(text).toContain("skills:      bugfix, lint");
    expect(text).toContain("effort:      low");
    expect(text).toContain("color:       red");
    expect(text).toContain("mcp servers: github");
  });

  it("counts hooks per stage and omits unset fields", () => {
    expect(
      agentDefinitionFieldLines({
        id: "a",
        name: "a",
        description: "d",
        triggers: [],
        mode: "edit",
        scope: "global",
        hooks: { preToolUse: [{ command: "x" }, { command: "y" }], subagentStop: [{ command: "z" }] },
      }),
    ).toEqual(["hooks:       preToolUse×2 subagentStop×1"]);
    expect(
      agentDefinitionFieldLines({ id: "a", name: "a", description: "d", triggers: [], mode: "edit", scope: "global" }),
    ).toEqual([]);
  });
});

describe("agent import", () => {
  it("lists the fields an import drops", () => {
    const source = join(cwd, "fixer.md");
    writeFileSync(source, EXTERNAL);
    agentImportCommand(source, {});
    const text = out.join("\n");
    expect(process.exitCode).toBeUndefined();
    expect(text).toContain('imported "fixer"');
    expect(text).toMatch(/not imported .*: hooks, permissionMode/);
    out = [];
    agentShowCommand("fixer");
    const shown = out.join("\n");
    expect(shown).toContain("disallowed:  web_fetch");
    expect(shown).not.toContain("permission:");
    expect(shown).not.toContain("hooks:");
  });
});
