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
          tools: ["read_file", "Grep"],
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
      // Claude Code's tool names mean SeekForge's.
      tools: ["read_file", "search_text"],
      color: "blue",
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
    [json({ a: { description: "d", prompt: "p", initialPrompt: "x" } }), "unsupported field(s) initialPrompt"],
    [
      json({ a: { description: "d", prompt: "p", disallowedTools: ["nope"] } }),
      '"disallowedTools" names no known tool: nope',
    ],
    [json({ a: { description: "d", prompt: "p", disallowedTools: ["Bash(rm:*)"] } }), "names no known tool"],
    [json({ a: { description: "d", prompt: "p", permissionMode: "yolo" } }), "invalid subagent permissionMode: yolo"],
    [json({ a: { description: "d", prompt: "p", permissionMode: 1 } }), '"permissionMode" must be a string'],
    [json({ a: { description: "d", prompt: "p", isolation: "container" } }), "invalid subagent isolation"],
    [json({ a: { description: "d", prompt: "p", effort: "extreme" } }), '"effort" must be low, medium, high or max'],
    [json({ a: { description: "d", prompt: "p", skills: ["Not Valid"] } }), '"skills" has invalid entries'],
    [
      json({ a: { description: "d", prompt: "p", mcpServers: [{ command: "npx" }] } }),
      '"mcpServers" must be an array of strings',
    ],
    [json({ a: { description: "d", prompt: "p", mcpServers: ["bad name"] } }), '"mcpServers" has invalid entries'],
    [json({ a: { description: "d", prompt: "p", hooks: [] } }), '"hooks" must be an object keyed by stage'],
    [
      json({ a: { description: "d", prompt: "p", hooks: { sessionStart: [{ command: "x" }] } } }),
      'hook stage "sessionStart" is not available',
    ],
    [json({ a: { description: "d", prompt: "p", hooks: { preToolUse: {} } } }), '"hooks.preToolUse" must be an array'],
    [
      json({ a: { description: "d", prompt: "p", hooks: { preToolUse: [{ match: "x" }] } } }),
      "a command hook needs a non-empty command",
    ],
    [
      json({ a: { description: "d", prompt: "p", hooks: { preToolUse: [{ type: "http", url: "https://x" }] } } }),
      "unsupported key(s) url",
    ],
    [
      json({ a: { description: "d", prompt: "p", hooks: { preToolUse: [{ type: "prompt", command: "x" }] } } }),
      "a prompt hook needs a non-empty prompt",
    ],
    [
      json({ a: { description: "d", prompt: "p", hooks: { preToolUse: [{ command: "x", timeout: 5 }] } } }),
      "unsupported key(s) timeout",
    ],
    [
      json({ a: { description: "d", prompt: "p", hooks: { preToolUse: [{ command: "x", match: "(a+)+" }] } } }),
      "is refused",
    ],
    [
      json({
        a: {
          description: "d",
          prompt: "p",
          hooks: { PreToolUse: [{ matcher: "Bash.*", hooks: [{ type: "command", command: "x" }] }] },
        },
      }),
      "is not a usable agent hook",
    ],
    [
      json({
        a: {
          description: "d",
          prompt: "p",
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "x" }] }] },
        },
      }),
      "unsupported key(s) prompt",
    ],
    [
      json({
        a: {
          description: "d",
          prompt: "p",
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x".repeat(5000) }] }] },
        },
      }),
      "is not a usable agent hook",
    ],
    [json({ a: { description: 1, prompt: "p" } }), '"description" must be a string'],
    [json({ a: { description: "d", prompt: "p", mode: "write" } }), '"mode" must be "ask" or "edit"'],
    [json({ a: { description: "d", prompt: "p", maxTurns: 0 } }), '"maxTurns" must be a positive integer'],
    [json({ a: { description: "d", prompt: "p", tools: [1] } }), '"tools" must be an array of strings'],
    [json({ a: { description: "d", prompt: "p", tools: ["a,b"] } }), 'may not contain ","'],
    [json({ a: { description: "d", prompt: "p", triggers: ["x|y"] } }), 'may not contain "|"'],
  ])("rejects %s", (raw, message) => {
    expect(() => parseInlineAgentDefinitions(raw)).toThrow(message);
  });

  it("accepts Claude Code's extended fields through the AGENT.md parser", () => {
    const [def] = parseInlineAgentDefinitions(
      json({
        fixer: {
          description: "fixes",
          prompt: "fix it",
          disallowedTools: ["Bash", "write_file"],
          permissionMode: "acceptEdits",
          isolation: "worktree",
          skills: "bugfix, bugfix, lint",
          effort: "xhigh",
          color: "Purple",
          mcpServers: ["github", "docs"],
        },
      }),
    );
    expect(def).toMatchObject({
      scope: "global",
      mode: "edit",
      disallowedTools: ["run_command", "write_file"],
      permissionMode: "acceptEdits",
      isolation: "worktree",
      skills: ["bugfix", "lint"],
      effort: "max",
      color: "purple",
      mcpServers: ["github", "docs"],
    });
  });

  it("makes a plan-mode agent read-only and drops a color no frontend can render", () => {
    const [def] = parseInlineAgentDefinitions(
      json({
        planner: { description: "plans", prompt: "p", permissionMode: "plan", color: "\u001b[31m", isolation: "none" },
      }),
    );
    expect(def?.mode).toBe("ask");
    expect(def?.permissionMode).toBe("plan");
    expect(def?.color).toBeUndefined();
    expect(def?.isolation).toBeUndefined();
  });

  it("accepts hooks in either shape, with user authority", () => {
    const [def] = parseInlineAgentDefinitions(
      json({
        gated: {
          description: "d",
          prompt: "p",
          hooks: {
            preToolUse: [{ match: "write_file", pattern: "src/", command: 'echo "pre" && ./gate.sh' }],
            PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "./lint.sh\nexit 0" }] }],
            Stop: [{ hooks: [{ command: "./done.sh" }] }],
            postToolUse: [],
          },
        },
      }),
    );
    expect(def?.scope).toBe("global");
    expect(def?.hooks).toEqual({
      preToolUse: [
        { match: "write_file", pattern: "src/", command: 'echo "pre" && ./gate.sh' },
        { match: "apply_patch", command: "./lint.sh\nexit 0" },
        { match: "write_file", command: "./lint.sh\nexit 0" },
      ],
      subagentStop: [{ command: "./done.sh" }],
    });
  });

  it("refuses more hooks per stage than an agent keeps", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ command: `./h${i}.sh` }));
    expect(() =>
      parseInlineAgentDefinitions(json({ a: { description: "d", prompt: "p", hooks: { preToolUse: many } } })),
    ).toThrow('too many "preToolUse" hooks (at most 16 per stage)');
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
