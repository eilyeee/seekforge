import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importExternalAgent, parseExternalAgent, renderAgentMarkdown } from "../../src/subagents/import.js";
import { loadAgentDefinitionsFromDirs } from "../../src/subagents/load.js";

// Inline fixture mimicking Meta_Kim canonical/agents frontmatter
// (meta-conductor.md shape) — tests never read the Meta_Kim checkout.
const META_KIM_AGENT = `---
version: 1.2.0
name: meta-conductor
tools: Read, Grep, Glob, Bash, Agent, WebFetch, WebSearch
description: Design workflow orchestration, business-flow blueprints, stage sequencing, and rhythm control.
type: agent
subagent_type: meta-governance
own: "Workflow family determination; dispatch board ownership; rhythm control"
do_not_touch: "SOUL.md design (->Genesis); safety hooks (->Sentinel)"
boundary: "Workflow orchestrator — sequences stages, not an executor."
trigger: "Multi-step tasks, Type C execution, rhythm optimization"
---

> GOVERNANCE LAYER AGENT — NOT FOR DIRECT EXECUTION
>
> This is a meta-agent (layer='meta', executionBlock=true).

# Meta-Conductor: Orchestration Meta

Owns rhythm orchestration mechanics.
`;

const EXECUTOR_AGENT = `---
name: bug-fixer
tools: Read, Grep, Bash
description: Fixes reported bugs end to end.
type: agent
trigger: "bugfix | fix bug"
---

# Bug Fixer

Fix the bug, run the tests.
`;

describe("parseExternalAgent", () => {
  it("parses Meta_Kim-style frontmatter and maps tool names", () => {
    const { def, droppedTools } = parseExternalAgent(META_KIM_AGENT);
    expect(def.id).toBe("meta-conductor");
    expect(def.name).toBe("meta-conductor");
    expect(def.description).toContain("workflow orchestration");
    expect(def.tools).toEqual(["read_file", "search_text", "list_files", "run_command", "web_fetch"]);
    expect(droppedTools).toEqual(["Agent", "WebSearch"]);
    expect(def.own).toContain("dispatch board ownership");
    expect(def.doNotTouch).toContain("SOUL.md design");
    expect(def.boundary).toContain("not an executor");
    expect(def.triggers).toEqual(["Multi-step tasks, Type C execution, rhythm optimization"]);
    expect(def.body).toContain("# Meta-Conductor");
  });

  it("infers mode ask for governance/meta types", () => {
    expect(parseExternalAgent(META_KIM_AGENT).def.mode).toBe("ask");
  });

  it("infers mode ask from execution-block body markers", () => {
    const blocked = EXECUTOR_AGENT.replace("Fix the bug", "executionBlock=true\nFix the bug");
    expect(parseExternalAgent(blocked).def.mode).toBe("ask");
    const notForDirect = EXECUTOR_AGENT.replace("Fix the bug", "NOT FOR DIRECT EXECUTION\nFix the bug");
    expect(parseExternalAgent(notForDirect).def.mode).toBe("ask");
  });

  it("infers mode edit for plain executors", () => {
    const { def, droppedTools } = parseExternalAgent(EXECUTOR_AGENT);
    expect(def.mode).toBe("edit");
    expect(def.tools).toEqual(["read_file", "search_text", "run_command"]);
    expect(droppedTools).toEqual([]);
  });

  it("keeps an explicit unsupported tool list as an empty whitelist", () => {
    const external = EXECUTOR_AGENT.replace("tools: Read, Grep, Bash", "tools: Agent, WebSearch");
    const { def, droppedTools } = parseExternalAgent(external);
    expect(def.tools).toEqual([]);
    expect(droppedTools).toEqual(["Agent", "WebSearch"]);

    const rendered = renderAgentMarkdown(def);
    expect(rendered).toContain('tools: ""');
    expect(parseExternalAgent(rendered).def.tools).toEqual([]);
  });

  it("rejects unusable names", () => {
    expect(() => parseExternalAgent("---\nversion: 1\n---\nbody")).toThrow(/name/);
    expect(() => parseExternalAgent("# no frontmatter")).toThrow(/frontmatter/);
  });
});

describe("importExternalAgent", () => {
  let src: string;
  let target: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "sf-agent-src-"));
    target = mkdtempSync(join(tmpdir(), "sf-agent-dst-"));
    writeFileSync(join(src, "meta-conductor.md"), META_KIM_AGENT);
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("writes canonical AGENT.md that round-trips through the loader", () => {
    const { dir, agent, droppedTools } = importExternalAgent(join(src, "meta-conductor.md"), {
      targetRoot: target,
    });
    expect(dir).toBe(join(target, "meta-conductor"));
    expect(droppedTools).toEqual(["Agent", "WebSearch"]);

    const written = readFileSync(join(dir, "AGENT.md"), "utf8");
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain('mode: "ask"');
    expect(written).toContain("# Meta-Conductor"); // original body preserved

    const loaded = loadAgentDefinitionsFromDirs([{ scope: "project", path: target }]);
    expect(loaded).toHaveLength(1);
    const def = loaded[0]!;
    expect(def.id).toBe("meta-conductor");
    expect(def.mode).toBe("ask");
    expect(def.tools).toEqual(agent.tools);
    expect(def.own).toBe(agent.own);
    expect(def.boundary).toBe(agent.boundary);
    expect(def.body).toContain("# Meta-Conductor");
  });

  it("round-trips an empty whitelist without granting all tools", () => {
    const source = join(src, "unsupported.md");
    writeFileSync(
      source,
      EXECUTOR_AGENT.replace("name: bug-fixer", "name: unsupported").replace("tools: Read, Grep, Bash", "tools: Agent"),
    );
    const imported = importExternalAgent(source, { targetRoot: target });
    expect(imported.agent.tools).toEqual([]);
    expect(loadAgentDefinitionsFromDirs([{ scope: "project", path: target }])[0]?.tools).toEqual([]);
  });

  it("refuses to overwrite without force, replaces with force", () => {
    importExternalAgent(join(src, "meta-conductor.md"), { targetRoot: target });
    expect(() => importExternalAgent(join(src, "meta-conductor.md"), { targetRoot: target })).toThrow(/--force/);
    expect(existsSync(join(target, "meta-conductor", "AGENT.md"))).toBe(true);
    const again = importExternalAgent(join(src, "meta-conductor.md"), { targetRoot: target, force: true });
    expect(again.agent.id).toBe("meta-conductor");
  });

  it("refuses to follow an existing agent-directory symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-agent-outside-"));
    try {
      symlinkSync(outside, join(target, "meta-conductor"));
      expect(() => importExternalAgent(join(src, "meta-conductor.md"), { targetRoot: target, force: true })).toThrow(
        /symlinked agent directory/,
      );
      expect(existsSync(join(outside, "AGENT.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to follow an existing AGENT.md symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-agent-outside-"));
    const outsideFile = join(outside, "protected.md");
    try {
      writeFileSync(outsideFile, "keep me");
      mkdirSync(join(target, "meta-conductor"));
      symlinkSync(outsideFile, join(target, "meta-conductor", "AGENT.md"));
      expect(() => importExternalAgent(join(src, "meta-conductor.md"), { targetRoot: target, force: true })).toThrow(
        /symlinked agent file/,
      );
      expect(readFileSync(outsideFile, "utf8")).toBe("keep me");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("renderAgentMarkdown", () => {
  it("omits empty fields and keeps max-turns numeric", () => {
    const md = renderAgentMarkdown({
      id: "x",
      name: "x",
      description: "d",
      triggers: [],
      mode: "edit",
      maxTurns: 7,
    });
    expect(md).not.toContain("trigger:");
    expect(md).not.toContain("tools:");
    expect(md).toContain("max-turns: 7");
  });

  it("roundtrips values containing quotes and backslashes through render→parse", () => {
    const description = 'Say "hi" and keep the \\ backslash';
    const md = renderAgentMarkdown({
      id: "quoter",
      name: "quoter",
      description,
      triggers: [],
      mode: "edit",
    });
    // Renderer emits JSON.stringify'd values; the parser must invert that, not
    // just strip the outer quotes (which would leave \" and \\ escapes intact).
    const { def } = parseExternalAgent(md);
    expect(def.description).toBe(description);
  });
});
