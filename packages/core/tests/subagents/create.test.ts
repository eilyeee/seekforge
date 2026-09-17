import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDefinition, validateNewAgent } from "../../src/subagents/create.js";
import { loadAgentDefinitionsFromDirs } from "../../src/subagents/load.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sf-agent-create-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sf-agent-outside-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("createAgentDefinition", () => {
  it("writes an AGENT.md the loader reads back with the given fields", () => {
    const path = createAgentDefinition(root, {
      id: "db-migrator",
      description: "Writes and checks  database\nmigrations",
      mode: "edit",
      tools: ["read_file", "apply_patch"],
      model: "deepseek-v4-pro",
    });
    expect(path).toBe(join(root, ".seekforge", "agents", "db-migrator", "AGENT.md"));
    const [agent] = loadAgentDefinitionsFromDirs([{ scope: "project", path: join(root, ".seekforge", "agents") }]);
    expect(agent).toMatchObject({
      id: "db-migrator",
      description: "Writes and checks database migrations",
      mode: "edit",
      tools: ["read_file", "apply_patch"],
      model: "deepseek-v4-pro",
      scope: "project",
    });
    expect(readFileSync(path, "utf8")).toContain("You are the db-migrator agent.");
  });

  it("omits tools and model when not given (every tool, default model)", () => {
    createAgentDefinition(root, { id: "helper", description: "Helps", mode: "ask" });
    const [agent] = loadAgentDefinitionsFromDirs([{ scope: "project", path: join(root, ".seekforge", "agents") }]);
    expect(agent?.tools).toBeUndefined();
    expect(agent?.model).toBeUndefined();
    expect(agent?.mode).toBe("ask");
  });

  it("refuses an existing id, invalid input, and a symlinked agents directory", () => {
    createAgentDefinition(root, { id: "dup", description: "one", mode: "ask" });
    expect(() => createAgentDefinition(root, { id: "dup", description: "two", mode: "ask" })).toThrow(/already exists/);
    expect(() => createAgentDefinition(root, { id: "Bad Id", description: "x", mode: "ask" })).toThrow(/agent id/);
    expect(validateNewAgent({ id: "ok", description: " ", mode: "ask" })).toMatch(/description/);
    expect(validateNewAgent({ id: "ok", description: "x", mode: "run" as never })).toMatch(/mode/);
    expect(validateNewAgent({ id: "ok", description: "x", mode: "ask", tools: ["a b"] })).toMatch(/tool names/);

    const linked = realpathSync(mkdtempSync(join(tmpdir(), "sf-agent-linked-")));
    try {
      mkdirSync(join(linked, ".seekforge"));
      symlinkSync(outside, join(linked, ".seekforge", "agents"));
      expect(() => createAgentDefinition(linked, { id: "escape", description: "x", mode: "ask" })).toThrow();
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});
