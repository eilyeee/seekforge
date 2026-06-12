import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TuiConfig } from "../config.js";
import {
  buildBugReport,
  findChangelogSection,
  formatConfigLines,
  formatHookLines,
  formatPermissionLines,
  formatReleaseNotes,
  formatStatusLines,
  type StatusInput,
} from "../command-surfaces.js";

function status(over: Partial<StatusInput>): StatusInput {
  return {
    model: "deepseek-v4-pro",
    projectPath: "/work/proj",
    approval: "confirm",
    vim: false,
    keySource: "env",
    costUsd: 0,
    totalTokens: 0,
    mcpServers: 0,
    extraDirs: 0,
    bgRunning: 0,
    detachedRuns: 0,
    ...over,
  };
}

describe("formatStatusLines", () => {
  it("renders the full aligned block with thinking, context and counts", () => {
    const lines = formatStatusLines(
      status({
        version: "0.7.0",
        sessionId: "20260612T100000-abc123",
        thinking: true,
        reasoningEffort: "max",
        sandbox: "workspace-write",
        vim: true,
        costUsd: 0.1234,
        totalTokens: 12400,
        contextPercent: 28.4,
        mcpServers: 2,
        extraDirs: 1,
        bgRunning: 1,
        detachedRuns: 2,
      }),
    );
    expect(lines[0]).toMatch(/^version\s+0\.7\.0$/);
    expect(lines).toContainEqual(expect.stringContaining("deepseek-v4-pro (thinking, effort max)"));
    expect(lines).toContainEqual(expect.stringMatching(/session\s+20260612T100000-abc123/));
    expect(lines).toContainEqual(expect.stringMatching(/vim\s+on/));
    expect(lines).toContainEqual(expect.stringMatching(/sandbox\s+workspace-write/));
    expect(lines).toContainEqual(expect.stringContaining("$0.1234 · 12.4K tokens"));
    expect(lines).toContainEqual(expect.stringMatching(/context\s+28% used/));
    expect(lines).toContainEqual(expect.stringMatching(/mcp\s+2 servers/));
    expect(lines).toContainEqual(expect.stringMatching(/extra dirs\s+1 dir$/));
    expect(lines).toContainEqual(expect.stringMatching(/background\s+1 running, 2 detached/));
    // all rows align: every line has the value starting at the same column
    const col = (lines[0] as string).search(/\s{2}\S/);
    for (const line of lines) expect(line.search(/\s{2}(?=\S)/)).toBe(col);
  });

  it("omits absent/zero rows and falls back to (new)/off defaults", () => {
    const lines = formatStatusLines(status({ keySource: "none" }));
    const text = lines.join("\n");
    expect(text).not.toContain("version");
    expect(text).not.toContain("context");
    expect(text).not.toContain("mcp");
    expect(text).not.toContain("extra dirs");
    expect(text).not.toContain("background");
    expect(lines).toContainEqual(expect.stringMatching(/session\s+\(new\)/));
    expect(lines).toContainEqual(expect.stringMatching(/sandbox\s+off/));
    expect(lines).toContainEqual(expect.stringMatching(/vim\s+off/));
    expect(lines).toContainEqual(expect.stringMatching(/api key\s+not set/));
  });
});

const CONFIG_PATHS = { global: "/home/u/.seekforge/config.json", project: "/work/proj/.seekforge/config.json" };

describe("formatConfigLines", () => {
  it("redacts the api key to sk-…last4", () => {
    const lines = formatConfigLines({ apiKey: "sk-proj-1234abcd9999" }, CONFIG_PATHS);
    expect(lines[0]).toBe("apiKey = sk-…9999");
    expect(lines.join("\n")).not.toContain("sk-proj-1234abcd9999");
  });

  it("summarizes object fields and keeps a stable declaration order", () => {
    const config: TuiConfig = {
      model: "deepseek-v4-flash",
      vim: true,
      permissionRules: [{ action: "deny", tool: "run_command", match: "rm " }],
      mcpServers: {
        fs: { command: "mcp-fs" },
        web: { command: "mcp-web" },
      } as TuiConfig["mcpServers"],
      hooks: { preToolUse: [{ command: "./gate.sh" }], sessionEnd: [{ command: "./bye.sh" }] },
      commandAllowlist: ["docker ps"],
    };
    const lines = formatConfigLines(config, CONFIG_PATHS);
    expect(lines).toContain("permissionRules = 1 rule");
    expect(lines).toContain("mcpServers = 2 servers");
    expect(lines).toContain("hooks = stages preToolUse,sessionEnd");
    expect(lines).toContain("commandAllowlist = 1 entry");
    // declaration order: model before commandAllowlist before hooks before vim
    const idx = (key: string) => lines.findIndex((l) => l.startsWith(`${key} =`));
    expect(idx("model")).toBeLessThan(idx("commandAllowlist"));
    expect(idx("commandAllowlist")).toBeLessThan(idx("hooks"));
    expect(idx("hooks")).toBeLessThan(idx("vim"));
  });

  it("always appends footer lines naming both paths and the edit hint", () => {
    const lines = formatConfigLines({}, CONFIG_PATHS);
    expect(lines[0]).toBe("(no settings configured — using defaults)");
    expect(lines).toContain(`global:  ${CONFIG_PATHS.global}`);
    expect(lines).toContain(`project: ${CONFIG_PATHS.project}`);
    expect(lines).toContain("/config edit opens the global file");
  });
});

describe("formatPermissionLines", () => {
  const base = {
    rules: [],
    builtinAllowlist: [],
    configAllowlist: [],
    sessionAllowlist: [],
    approval: "confirm",
  };

  it("renders rules as action tool(match) under approval + sandbox", () => {
    const lines = formatPermissionLines({
      ...base,
      approval: "auto",
      sandbox: "restricted",
      rules: [
        { action: "deny", tool: "run_command", match: "rm *" },
        { action: "allow", tool: "*" },
      ],
    });
    expect(lines[0]).toBe("approval mode: auto");
    expect(lines[1]).toBe("sandbox: restricted");
    expect(lines).toContain("rules (2):");
    expect(lines).toContain("  deny run_command(rm *)");
    expect(lines).toContain("  allow *");
  });

  it("summarizes the builtin allowlist to 10 entries with +N more", () => {
    const builtin = Array.from({ length: 15 }, (_, i) => `cmd${i}`);
    const lines = formatPermissionLines({ ...base, builtinAllowlist: builtin });
    const builtinLine = lines.find((l) => l.startsWith("builtin allowlist:")) as string;
    expect(builtinLine).toContain("cmd0");
    expect(builtinLine).toContain("cmd9");
    expect(builtinLine).not.toContain("cmd10");
    expect(builtinLine).toContain("+5 more");
  });

  it("lists config and session allowlists in full", () => {
    const lines = formatPermissionLines({
      ...base,
      configAllowlist: ["npm run build", "docker ps"],
      sessionAllowlist: ["terraform plan"],
    });
    expect(lines).toContain("config allowlist: npm run build, docker ps");
    expect(lines).toContain("session allowlist: terraform plan");
  });

  it("shows empty-state lines for every section, sandbox defaulting to off", () => {
    const lines = formatPermissionLines(base);
    expect(lines).toContain("sandbox: off");
    expect(lines).toContain("rules: none configured (permissionRules in config)");
    expect(lines).toContain("builtin allowlist: (empty)");
    expect(lines).toContain("config allowlist: (none — commandAllowlist in config)");
    expect(lines).toContain('session allowlist: (none — press "a" on a permission prompt to add)');
  });
});

describe("formatHookLines", () => {
  it("marks blocking stages and caps commands at 60 chars", () => {
    const long = "x".repeat(80);
    const lines = formatHookLines({
      preToolUse: [{ command: "./gate.sh" }, { command: long }],
      postToolUse: [{ command: "./log.sh" }],
      userPromptSubmit: [{ command: "./prompt-check.sh" }],
    });
    expect(lines[0]).toBe("preToolUse (blocking): ./gate.sh");
    expect(lines[1]).toBe(`preToolUse (blocking): ${"x".repeat(60)}…`);
    expect(lines[2]).toBe("postToolUse: ./log.sh");
    expect(lines[3]).toBe("userPromptSubmit (blocking): ./prompt-check.sh");
    expect(lines).toHaveLength(4);
  });

  it("explains configuration when no hooks exist", () => {
    for (const hooks of [undefined, {}]) {
      const lines = formatHookLines(hooks);
      expect(lines[0]).toBe("no hooks configured");
      expect(lines.join("\n")).toContain('"hooks"');
      expect(lines.join("\n")).toContain("preToolUse, userPromptSubmit");
    }
  });
});

describe("findChangelogSection / formatReleaseNotes", () => {
  const tmpRoots: string[] = [];
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "sf-changelog-"));
    tmpRoots.push(root);
    return root;
  }

  it("walks up from a nested start dir and parses the first section", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "CHANGELOG.md"),
      "# Changelog\n\n## 0.7.0 — round 5\n\n- sandbox\n- hooks\n\n## 0.6.0\n\n- older\n",
    );
    const nested = join(root, "apps", "tui");
    mkdirSync(nested, { recursive: true });
    const section = findChangelogSection([nested]);
    expect(section).toEqual({ heading: "0.7.0 — round 5", lines: ["", "- sandbox", "- hooks"] });
  });

  it("caps the body at 40 lines", () => {
    const root = makeRoot();
    const body = Array.from({ length: 80 }, (_, i) => `- item ${i}`).join("\n");
    writeFileSync(join(root, "CHANGELOG.md"), `## 1.0.0\n${body}\n`);
    const section = findChangelogSection([root]);
    expect(section?.lines).toHaveLength(40);
    expect(section?.lines[39]).toBe("- item 39");
  });

  it("returns null when no CHANGELOG.md is reachable within 4 levels", () => {
    const root = makeRoot();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findChangelogSection([nested])).toBeNull();
  });

  it("formats a found section as heading + body", () => {
    const lines = formatReleaseNotes({ heading: "0.7.0 — round 5", lines: ["- sandbox"] });
    expect(lines).toEqual(["0.7.0 — round 5", "- sandbox"]);
  });

  it("falls back to the hosted changelog URL when nothing was found", () => {
    expect(formatReleaseNotes(null, "0.7.0")).toEqual([
      "version 0.7.0 — see github.com/eilyeee/seekforge/blob/main/CHANGELOG.md",
    ]);
    expect(formatReleaseNotes(null)).toEqual([
      "SeekForge — see github.com/eilyeee/seekforge/blob/main/CHANGELOG.md",
    ]);
  });
});

describe("buildBugReport", () => {
  const base = {
    platform: "darwin",
    nodeVersion: "v22.1.0",
    model: "deepseek-v4-pro",
    doctorLines: ["✓ api key  configured", "✗ editor  $EDITOR unset"],
  };

  it("contains the env table, doctor block, placeholders and issues URL", () => {
    const report = buildBugReport({ ...base, version: "0.7.0" });
    expect(report.startsWith("## SeekForge bug report")).toBe(true);
    expect(report).toContain("| version | 0.7.0 |");
    expect(report).toContain("| platform | darwin |");
    expect(report).toContain("| node | v22.1.0 |");
    expect(report).toContain("| model | deepseek-v4-pro |");
    expect(report).toContain("### Doctor");
    expect(report).toContain("✓ api key  configured");
    expect(report).toContain("### What happened");
    expect(report).toContain("### Expected");
    expect(report.trimEnd().endsWith("https://github.com/eilyeee/seekforge/issues")).toBe(true);
  });

  it("includes the last error only when present", () => {
    expect(buildBugReport(base)).not.toContain("### Last error");
    const report = buildBugReport({ ...base, lastError: "TypeError: boom" });
    expect(report).toContain("### Last error");
    expect(report).toContain("TypeError: boom");
    // version falls back to unknown
    expect(report).toContain("| version | unknown |");
  });
});
