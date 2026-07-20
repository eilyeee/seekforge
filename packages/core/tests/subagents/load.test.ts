import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentDefinitionsFromDirs, parseAgentMarkdown } from "../../src/subagents/load.js";

const CANONICAL = `---
name: code-reviewer
description: |
  Reviews diffs for correctness and style issues.
  Reports findings, never edits.
trigger: review | code review | 审查
tools: read_file, search_text, list_files
mode: ask
own: "Review verdicts and findings"
do_not_touch: "Source files (never edits)"
boundary: "Reviewer — reads and reports, not an executor."
max-turns: 8
---

# Reviewer procedure

1. Read the diff.
2. Report findings.
`;

function writeAgent(root: string, id: string, markdown: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "AGENT.md"), markdown);
}

describe("parseAgentMarkdown", () => {
  it("parses the canonical frontmatter incl. block scalars, | triggers and comma tools", () => {
    const def = parseAgentMarkdown("project", "code-reviewer", CANONICAL);
    expect(def.id).toBe("code-reviewer");
    expect(def.name).toBe("code-reviewer");
    expect(def.description).toBe("Reviews diffs for correctness and style issues. Reports findings, never edits.");
    expect(def.triggers).toEqual(["review", "code review", "审查"]);
    expect(def.tools).toEqual(["read_file", "search_text", "list_files"]);
    expect(def.mode).toBe("ask");
    expect(def.own).toBe("Review verdicts and findings");
    expect(def.doNotTouch).toBe("Source files (never edits)");
    expect(def.boundary).toContain("not an executor");
    expect(def.maxTurns).toBe(8);
    expect(def.scope).toBe("project");
    expect(def.body).toContain("# Reviewer procedure");
  });

  it("defaults: mode edit, no tools whitelist, no maxTurns", () => {
    const def = parseAgentMarkdown("global", "fixer", "---\nname: fixer\ndescription: fixes things\n---\nbody");
    expect(def.mode).toBe("edit");
    expect(def.tools).toBeUndefined();
    expect(def.maxTurns).toBeUndefined();
    expect(def.triggers).toEqual([]);
    expect(def.own).toBeUndefined();
  });

  it("preserves an explicitly empty tools whitelist", () => {
    const def = parseAgentMarkdown("project", "isolated", '---\nname: isolated\ntools: ""\n---\nbody');
    expect(def.tools).toEqual([]);
  });

  it.each([
    ["unknown mode", "mode: execute"],
    ["empty mode", "mode:"],
    ["trailing max-turns junk", "max-turns: 8turns"],
    ["fractional max-turns", "max-turns: 1.5"],
    ["zero max-turns", "max-turns: 0"],
    ["unsafe max-turns", "max-turns: 999999999999999999999"],
  ])("rejects %s instead of coercing it", (_label, field) => {
    expect(() => parseAgentMarkdown("project", "unsafe", `---\nname: unsafe\n${field}\n---\nbody`)).toThrow(
      /invalid subagent/,
    );
  });
});

describe("loadAgentDefinitionsFromDirs", () => {
  let globalRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    globalRoot = mkdtempSync(join(tmpdir(), "sf-agents-g-"));
    projectRoot = mkdtempSync(join(tmpdir(), "sf-agents-p-"));
  });
  afterEach(() => {
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("does not follow an agents root symlink outside its configured directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-agents-outside-"));
    try {
      writeAgent(outside, "injected", CANONICAL);
      const linkedRoot = join(projectRoot, "linked");
      symlinkSync(outside, linkedRoot, "dir");

      expect(loadAgentDefinitionsFromDirs([{ scope: "project", path: linkedRoot }])).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink in an agents root parent path", () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-agents-parent-outside-"));
    try {
      const agents = join(outside, "agents");
      writeAgent(agents, "injected", CANONICAL);
      const linkedParent = join(projectRoot, "linked-parent");
      symlinkSync(outside, linkedParent, "dir");

      expect(loadAgentDefinitionsFromDirs([{ scope: "project", path: join(linkedParent, "agents") }])).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("loads agents and lets project override global by id", () => {
    writeAgent(globalRoot, "code-reviewer", CANONICAL);
    writeAgent(globalRoot, "doc-writer", "---\nname: doc-writer\ndescription: global docs\n---\n");
    writeAgent(projectRoot, "doc-writer", "---\nname: doc-writer\ndescription: project docs\nmode: ask\n---\n");

    const defs = loadAgentDefinitionsFromDirs([
      { scope: "global", path: globalRoot },
      { scope: "project", path: projectRoot },
    ]);
    expect(defs.map((d) => d.id).sort()).toEqual(["code-reviewer", "doc-writer"]);
    const doc = defs.find((d) => d.id === "doc-writer")!;
    expect(doc.scope).toBe("project");
    expect(doc.description).toBe("project docs");
    expect(doc.mode).toBe("ask");
  });

  it("skips malformed dirs silently", () => {
    writeAgent(globalRoot, "good", "---\nname: good\ndescription: ok\n---\n");
    mkdirSync(join(globalRoot, "no-agent-md"), { recursive: true });
    writeAgent(globalRoot, "bad-frontmatter", "# not frontmatter at all");
    writeAgent(globalRoot, "bad-mode", "---\nname: bad-mode\nmode: execute\n---\n");
    writeAgent(globalRoot, "bad-turns", "---\nname: bad-turns\nmax-turns: 2x\n---\n");
    writeAgent(globalRoot, "Bad_Dir_Name", "---\nname: x\n---\n");
    writeFileSync(join(globalRoot, "stray-file.md"), "not a dir");

    const defs = loadAgentDefinitionsFromDirs([{ scope: "global", path: globalRoot }]);
    expect(defs.map((d) => d.id)).toEqual(["good"]);
  });

  it("returns [] for missing roots", () => {
    expect(loadAgentDefinitionsFromDirs([{ scope: "global", path: join(globalRoot, "nope") }])).toEqual([]);
  });

  it("does not load an AGENT.md symlink that escapes its configured root", () => {
    const outside = join(projectRoot, "outside.md");
    writeFileSync(outside, "---\nname: escaped\nmode: edit\n---\noutside instructions\n");
    const dir = join(globalRoot, "escaped");
    mkdirSync(dir);
    symlinkSync(outside, join(dir, "AGENT.md"));

    expect(loadAgentDefinitionsFromDirs([{ scope: "project", path: globalRoot }])).toEqual([]);
  });

  it("skips an AGENT.md that exceeds the definition byte limit", () => {
    writeAgent(globalRoot, "oversized", `---\nname: oversized\n---\n${"x".repeat(256 * 1024)}`);

    expect(loadAgentDefinitionsFromDirs([{ scope: "project", path: globalRoot }])).toEqual([]);
  });
});
