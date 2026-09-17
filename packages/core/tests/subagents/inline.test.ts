import { describe, expect, it } from "vitest";
import { parseInlineAgentDefinitions, withInlineAgents } from "../../src/subagents/inline.js";
import { BUILTIN_AGENTS } from "../../src/subagents/builtins.js";

const json = (value: unknown) => JSON.stringify(value);

describe("parseInlineAgentDefinitions", () => {
  it("maps Claude Code's shape onto an AgentDefinition", () => {
    const [def] = parseInlineAgentDefinitions(
      json({
        "code-reviewer": {
          description: "Reviews diffs\nfor bugs",
          prompt: 'You review code. Quote "exactly".\nBe terse.',
          tools: ["read_file", "grep"],
          model: "deepseek-v4-pro",
          color: "blue",
        },
      }),
    );
    expect(def).toEqual({
      id: "code-reviewer",
      scope: "global",
      name: "code-reviewer",
      description: "Reviews diffs for bugs",
      triggers: [],
      tools: ["read_file", "grep"],
      mode: "edit",
      own: undefined,
      doNotTouch: undefined,
      boundary: undefined,
      maxTurns: undefined,
      model: "deepseek-v4-pro",
      body: 'You review code. Quote "exactly".\nBe terse.',
    });
  });

  it("accepts SeekForge's own fields and list spellings", () => {
    const [def] = parseInlineAgentDefinitions(
      json({
        scout: {
          description: "explores",
          prompt: "look around",
          name: "Scout",
          mode: "ask",
          maxTurns: 4,
          tools: "read_file, list_dir",
          triggers: ["where is", "find"],
          own: "reading",
          doNotTouch: "src/",
          boundary: "read only",
          model: "inherit",
        },
      }),
    );
    expect(def).toMatchObject({
      name: "Scout",
      mode: "ask",
      maxTurns: 4,
      tools: ["read_file", "list_dir"],
      triggers: ["where is", "find"],
      own: "reading",
      doNotTouch: "src/",
      boundary: "read only",
      model: undefined,
    });
  });

  it("keeps an explicit empty tool list (no tools) distinct from an absent one", () => {
    const [none, all] = parseInlineAgentDefinitions(
      json({ a: { description: "d", prompt: "p", tools: [] }, b: { description: "d", prompt: "p" } }),
    );
    expect(none?.tools).toEqual([]);
    expect(all?.tools).toBeUndefined();
  });

  it.each([
    ["{", "not valid JSON"],
    [json([]), "JSON object keyed by agent id"],
    [json({}), "defines no agents"],
    [json({ Bad_Id: { description: "d", prompt: "p" } }), "kebab-case"],
    [json({ a: "x" }), "must be an object"],
    [json({ a: { prompt: "p" } }), '"description" is required'],
    [json({ a: { description: "d" } }), '"prompt" is required'],
    [json({ a: { description: "d", prompt: "p", disallowedTools: ["x"] } }), "unsupported field(s) disallowedTools"],
    [json({ a: { description: "d", prompt: "p", permissionMode: "plan" } }), "unsupported field(s) permissionMode"],
    [json({ a: { description: 1, prompt: "p" } }), '"description" must be a string'],
    [json({ a: { description: "d", prompt: "p", mode: "write" } }), '"mode" must be "ask" or "edit"'],
    [json({ a: { description: "d", prompt: "p", maxTurns: 0 } }), '"maxTurns" must be a positive integer'],
    [json({ a: { description: "d", prompt: "p", tools: [1] } }), '"tools" must be an array of strings'],
    [json({ a: { description: "d", prompt: "p", tools: ["a,b"] } }), 'may not contain ","'],
    [json({ a: { description: "d", prompt: "p", triggers: ["x|y"] } }), 'may not contain "|"'],
  ])("rejects %s", (raw, message) => {
    expect(() => parseInlineAgentDefinitions(raw)).toThrow(message);
  });

  it("bounds the definition count and size", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, { description: "d", prompt: "p" }]));
    expect(() => parseInlineAgentDefinitions(json(many))).toThrow("more than 32 agents");
    expect(() =>
      parseInlineAgentDefinitions(json({ a: { description: "d", prompt: "x".repeat(300 * 1024) } })),
    ).toThrow("exceeds");
  });
});

describe("withInlineAgents", () => {
  it("overrides a loaded definition of the same id and keeps the rest", () => {
    const inline = parseInlineAgentDefinitions(json({ reviewer: { description: "mine", prompt: "p" } }));
    const merged = withInlineAgents(BUILTIN_AGENTS, inline);
    expect(merged).toHaveLength(BUILTIN_AGENTS.length);
    expect(merged.find((d) => d.id === "reviewer")?.description).toBe("mine");
  });
});
