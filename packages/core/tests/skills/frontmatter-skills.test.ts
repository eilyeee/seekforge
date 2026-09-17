import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSkillSignalCache,
  configureSkillSources,
  importExternalSkill,
  loadSkillsDetailed,
  loadSkillsDetailedFromDirs,
  loadSkillsFromDirs,
  removeSkill,
  selectSkills,
  setSkillEnabled,
  skillSupplyChainReport,
} from "../../src/skills/index.js";
import type { PluginContributions } from "../../src/plugins/index.js";
import { makeTempDir, skillJson, writeSkillDir } from "./helpers.js";

const NO_PLUGINS: PluginContributions = { skillRoots: [], agentRoots: [], mcpServers: {}, hooks: {}, plugins: [] };

const CLAUDE_SKILL = [
  "---",
  "name: release-notes",
  "description: Draft release notes from merged changes",
  "when_to_use: Use when the user asks for a changelog or release notes.",
  "argument-hint: [version]",
  "arguments: [version, audience]",
  "allowed-tools: Bash(git log:*), Read",
  "disallowed-tools:",
  "  - Write",
  "  - Bash(git push:*)",
  "model: deepseek-v4-pro",
  "effort: high",
  "context: fork",
  "agent: explorer",
  "disable-model-invocation: false",
  "user-invocable: false",
  "paths: docs/**, CHANGELOG.md",
  "---",
  "# Release notes",
  "",
  "Summarize $version for $audience.",
  "",
].join("\n");

let previousHome: string | undefined;
let home: string;

beforeEach(() => {
  previousHome = process.env.SEEKFORGE_HOME;
  home = makeTempDir();
  process.env.SEEKFORGE_HOME = home;
  configureSkillSources({});
  clearSkillSignalCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  configureSkillSources({});
});

describe("SKILL.md frontmatter skills", () => {
  it("loads a Claude Code skill without skill.json and maps every invocation field", () => {
    const root = makeTempDir();
    writeSkillDir(root, "release-notes", undefined, CLAUDE_SKILL);
    const loaded = loadSkillsDetailedFromDirs([{ scope: "global", path: root, root: "claude" }]);
    expect(loaded.diagnostics).toEqual([]);
    const skill = loaded.skills.find((candidate) => candidate.id === "release-notes");
    expect(skill).toMatchObject({
      scope: "global",
      name: "release-notes",
      description: "Draft release notes from merged changes",
      whenToUse: "Use when the user asks for a changelog or release notes.",
      argumentHint: "[version]",
      argumentNames: ["version", "audience"],
      allowedTools: ["Bash(git log:*)", "Read"],
      disallowedTools: ["Write", "Bash(git push:*)"],
      model: "deepseek-v4-pro",
      effort: "high",
      context: "fork",
      agent: "explorer",
      userInvocable: false,
      paths: ["docs/**", "CHANGELOG.md"],
      source: { format: "frontmatter", root: "claude" },
      risk: "medium",
      enabled: true,
    });
    expect(skill?.disableModelInvocation).toBeUndefined();
    // The body, not the frontmatter, is what a model reads.
    expect(skill?.content).toBe("# Release notes\n\nSummarize $version for $audience.");
  });

  it("keeps a brace glob whole when paths is a comma-separated string", () => {
    const root = makeTempDir();
    writeSkillDir(root, "globs", undefined, "---\npaths: src/**/*.{ts,tsx}, docs/*.md\n---\nx\n");
    expect(loadSkillsFromDirs([{ scope: "project", path: root }]).find((s) => s.id === "globs")?.paths).toEqual([
      "src/**/*.{ts,tsx}",
      "docs/*.md",
    ]);
  });

  it("derives name and description when the frontmatter omits them", () => {
    const root = makeTempDir();
    writeSkillDir(root, "plain", undefined, "# Plain\n\nFirst paragraph\nspans two lines.\n\nSecond one.\n");
    const skill = loadSkillsFromDirs([{ scope: "project", path: root }]).find((s) => s.id === "plain");
    expect(skill).toMatchObject({ name: "plain", description: "First paragraph spans two lines." });
    expect(skill?.source).toEqual({ format: "frontmatter", root: "seekforge" });
  });

  it("lets skill.json win for every field it sets, and frontmatter fill the empty ones", () => {
    const root = makeTempDir();
    writeSkillDir(
      root,
      "mixed",
      { ...skillJson("mixed", { description: "", tags: [] }), allowedTools: ["run_command(pnpm test)"] },
      "---\nname: From frontmatter\ndescription: fm description\ntags: a, b\nallowed-tools: Read\nmodel: m1\n---\nbody\n",
    );
    const skill = loadSkillsFromDirs([{ scope: "global", path: root }]).find((s) => s.id === "mixed");
    expect(skill).toMatchObject({
      name: "mixed",
      description: "fm description",
      tags: ["a", "b"],
      allowedTools: ["run_command(pnpm test)"],
      model: "m1",
      content: "body",
      source: { format: "skill.json", root: "seekforge" },
    });
  });

  it("keeps a skill.json skill's SKILL.md byte-for-byte when it has no frontmatter", () => {
    const root = makeTempDir();
    const md = "# Skill\n\n## Procedure\n\n1. do it\n";
    writeSkillDir(root, "legacy", skillJson("legacy"), md);
    expect(loadSkillsFromDirs([{ scope: "project", path: root }]).find((s) => s.id === "legacy")?.content).toBe(md);
  });

  it.each([
    ["context: forked", /context/],
    ["disable-model-invocation: maybe", /disable-model-invocation/],
    ["allowed-tools: Bash(git status", /allowedTools/],
    ["effort: extreme", /effort/],
    ["arguments: [not valid]", /argumentNames/],
  ])("refuses frontmatter %s with a diagnostic", (line, message) => {
    const root = makeTempDir();
    writeSkillDir(root, "broken", undefined, `---\ndescription: d\n${line}\n---\nbody\n`);
    const loaded = loadSkillsDetailedFromDirs([{ scope: "project", path: root }]);
    expect(loaded.skills.some((skill) => skill.id === "broken")).toBe(false);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ id: "broken", code: "invalid_definition", message: expect.stringMatching(message) }),
    ]);
  });

  it("reports a directory with neither file", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "empty"));
    const loaded = loadSkillsDetailedFromDirs([{ scope: "project", path: root }]);
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ id: "empty", code: "missing_definition" })]);
  });
});

describe(".claude/skills roots", () => {
  it("reads the project .claude/skills and lets .seekforge/skills win an id clash", () => {
    const ws = makeTempDir();
    writeSkillDir(path.join(ws, ".claude", "skills"), "shared", undefined, "---\ndescription: claude copy\n---\nx\n");
    writeSkillDir(path.join(ws, ".claude", "skills"), "only-claude", undefined, "---\ndescription: c\n---\nx\n");
    writeSkillDir(
      path.join(ws, ".seekforge", "skills"),
      "shared",
      skillJson("shared", { description: "sf copy" }),
      "y",
    );
    const skills = loadSkillsDetailed(ws, NO_PLUGINS).skills;
    expect(skills.find((s) => s.id === "shared")?.description).toBe("sf copy");
    expect(skills.find((s) => s.id === "only-claude")).toMatchObject({
      scope: "project",
      source: { format: "frontmatter", root: "claude" },
    });
  });

  it("a project .claude skill still overrides a user-level SeekForge skill", () => {
    const ws = makeTempDir();
    writeSkillDir(path.join(home, ".seekforge", "skills"), "shared", skillJson("shared", { description: "user" }), "y");
    writeSkillDir(path.join(ws, ".claude", "skills"), "shared", undefined, "---\ndescription: project\n---\nx\n");
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.find((s) => s.id === "shared")).toMatchObject({
      description: "project",
      scope: "project",
    });
  });

  it("reads ~/.claude/skills only when the user opted in", () => {
    const ws = makeTempDir();
    writeSkillDir(path.join(home, ".claude", "skills"), "personal", undefined, "---\ndescription: mine\n---\nx\n");
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.some((s) => s.id === "personal")).toBe(false);
    expect(
      loadSkillsDetailed(ws, NO_PLUGINS, { claudeUserSkills: true }).skills.find((s) => s.id === "personal"),
    ).toMatchObject({ scope: "global", source: { root: "claude" } });
    configureSkillSources({ claudeUserSkills: true });
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.some((s) => s.id === "personal")).toBe(true);
    // ~/.seekforge/skills still wins the clash inside the user layer.
    writeSkillDir(
      path.join(home, ".seekforge", "skills"),
      "personal",
      skillJson("personal", { description: "sf" }),
      "y",
    );
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.find((s) => s.id === "personal")?.description).toBe("sf");
  });

  it("refuses a symlinked .claude directory", () => {
    const ws = makeTempDir();
    const elsewhere = makeTempDir();
    writeSkillDir(path.join(elsewhere, "skills"), "sneaky", undefined, "---\ndescription: s\n---\nx\n");
    fs.symlinkSync(elsewhere, path.join(ws, ".claude"));
    const loaded = loadSkillsDetailed(ws, NO_PLUGINS);
    expect(loaded.skills.some((s) => s.id === "sneaky")).toBe(false);
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ code: "invalid_root", scope: "project" })]);
  });
});

describe("selection and management of frontmatter skills", () => {
  it("never auto-selects a skill that disables model invocation, and gates on paths", () => {
    const ws = makeTempDir();
    fs.writeFileSync(path.join(ws, "main.go"), "package main\n");
    const root = makeTempDir();
    writeSkillDir(
      root,
      "manual",
      undefined,
      "---\ndescription: d\ntriggers: [deploy]\ndisable-model-invocation: true\n---\nx\n",
    );
    writeSkillDir(root, "gated-py", undefined, "---\ndescription: d\ntriggers: [deploy]\npaths: ['**/*.py']\n---\nx\n");
    writeSkillDir(root, "gated-go", undefined, "---\ndescription: d\ntriggers: [deploy]\npaths: ['**/*.go']\n---\nx\n");
    const skills = loadSkillsFromDirs([{ scope: "project", path: root }]);
    const selected = selectSkills("deploy the service", skills, { workspace: ws, useFeedback: false });
    expect(selected.map((selection) => selection.skill.id)).toEqual(["gated-go"]);
  });

  it("disables a .claude skill with a marker and re-enables it by removing the marker", () => {
    const ws = makeTempDir();
    writeSkillDir(path.join(ws, ".claude", "skills"), "cc-skill", undefined, "---\ndescription: c\n---\nx\n");
    const disabled = setSkillEnabled(ws, "cc-skill", false);
    expect(disabled.action).toBe("marker");
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.some((s) => s.id === "cc-skill")).toBe(false);
    setSkillEnabled(ws, "cc-skill", true);
    expect(fs.existsSync(path.join(ws, ".seekforge", "skills", "cc-skill"))).toBe(false);
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.some((s) => s.id === "cc-skill")).toBe(true);
    // Unknown ids are still refused.
    expect(() => setSkillEnabled(ws, "nobody", false)).toThrow(/unknown skill/);
  });

  it("disables and removes a SKILL.md-only skill in its own store", () => {
    const ws = makeTempDir();
    const root = path.join(ws, ".seekforge", "skills");
    writeSkillDir(root, "fm-only", undefined, "---\ndescription: c\n---\nx\n");
    expect(setSkillEnabled(ws, "fm-only", true).action).toBe("edited");
    expect(fs.existsSync(path.join(root, "fm-only", "skill.json"))).toBe(false);
    setSkillEnabled(ws, "fm-only", false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "fm-only", "skill.json"), "utf8"))).toEqual({
      apiVersion: 1,
      id: "fm-only",
      enabled: false,
    });
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.some((s) => s.id === "fm-only")).toBe(false);
    setSkillEnabled(ws, "fm-only", true);
    expect(loadSkillsDetailed(ws, NO_PLUGINS).skills.find((s) => s.id === "fm-only")?.description).toBe("c");
    removeSkill(ws, "fm-only");
    expect(fs.existsSync(path.join(root, "fm-only"))).toBe(false);
  });

  it("imports a Claude Code skill verbatim so its invocation fields survive", () => {
    const src = makeTempDir();
    const target = makeTempDir();
    fs.writeFileSync(path.join(src, "SKILL.md"), CLAUDE_SKILL);
    const { dir } = importExternalSkill(src, { targetRoot: target });
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(CLAUDE_SKILL);
    const skill = loadSkillsFromDirs([{ scope: "global", path: target }]).find((s) => s.id === "release-notes");
    expect(skill).toMatchObject({ allowedTools: ["Bash(git log:*)", "Read"], context: "fork", risk: "medium" });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: bad\ncontext: sideways\n---\nx\n");
    expect(() => importExternalSkill(src, { targetRoot: target })).toThrow(/not an importable skill/);
  });
});

describe("skill supply-chain digests", () => {
  it("keeps a skill.json skill's digest identical to the pre-frontmatter canonical form", () => {
    const ws = makeTempDir();
    const md = "# Legacy\n\n## Procedure\n\n1. step\n";
    writeSkillDir(path.join(ws, ".seekforge", "skills"), "legacy", { apiVersion: 1, ...skillJson("legacy") }, md);
    const entry = skillSupplyChainReport(ws).entries.find((candidate) => candidate.id === "legacy");
    const canonical = JSON.stringify({
      apiVersion: 1,
      id: "legacy",
      scope: "project",
      name: "legacy",
      description: "description of legacy",
      tags: [],
      triggers: [],
      negativeTriggers: [],
      taskTypes: [],
      priority: 50,
      risk: "medium",
      dependsOn: [],
      conflictsWith: [],
      order: 0,
      content: md,
    });
    expect(entry?.digest).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("changes a frontmatter skill's digest when an invocation field changes", () => {
    const ws = makeTempDir();
    const dir = writeSkillDir(
      path.join(ws, ".claude", "skills"),
      "tooly",
      undefined,
      "---\nallowed-tools: Read\n---\nx\n",
    );
    const before = skillSupplyChainReport(ws).entries.find((entry) => entry.id === "tooly")?.digest;
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nallowed-tools: Read, Bash\n---\nx\n");
    const after = skillSupplyChainReport(ws).entries.find((entry) => entry.id === "tooly")?.digest;
    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });
});
