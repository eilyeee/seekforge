import { describe, expect, it } from "vitest";
import { parseInput } from "../commands.js";

describe("parseInput", () => {
  it("treats blank lines as empty", () => {
    expect(parseInput("   ").kind).toBe("empty");
  });

  it("treats plain text as a task", () => {
    const p = parseInput("fix the bug in app.ts");
    expect(p).toEqual({ kind: "task", text: "fix the bug in app.ts" });
  });

  it("parses bare slash commands", () => {
    expect(parseInput("/help")).toEqual({ kind: "slash", command: { name: "help" } });
    expect(parseInput("/new")).toEqual({ kind: "slash", command: { name: "new" } });
    expect(parseInput("/context")).toEqual({ kind: "slash", command: { name: "context" } });
    expect(parseInput("/usage")).toEqual({ kind: "slash", command: { name: "usage" } });
  });

  it("treats /exit as /quit", () => {
    expect(parseInput("/exit")).toEqual({ kind: "slash", command: { name: "quit" } });
    expect(parseInput("/quit")).toEqual({ kind: "slash", command: { name: "quit" } });
  });

  it("parses /model with and without an argument", () => {
    expect(parseInput("/model deepseek-coder")).toEqual({
      kind: "slash",
      command: { name: "model", arg: "deepseek-coder" },
    });
    expect(parseInput("/model")).toEqual({ kind: "slash", command: { name: "model", arg: undefined } });
  });

  it("is case-insensitive on the command name", () => {
    expect(parseInput("/HELP")).toEqual({ kind: "slash", command: { name: "help" } });
  });

  it("flags unknown slash commands", () => {
    const p = parseInput("/frobnicate now");
    expect(p).toEqual({ kind: "slash", command: { name: "unknown", raw: "/frobnicate now" } });
  });
});

describe("parseInput v2.1 additions", () => {
  it("parses ! as a local bash passthrough", () => {
    expect(parseInput("!ls -la")).toEqual({ kind: "bash", command: "ls -la" });
    expect(parseInput("! git status")).toEqual({ kind: "bash", command: "git status" });
    expect(parseInput("!")).toEqual({ kind: "empty" });
  });

  it("parses /tasks with a kill argument", () => {
    expect(parseInput("/tasks")).toEqual({ kind: "slash", command: { name: "tasks" } });
    expect(parseInput("/tasks kill bg-1")).toEqual({ kind: "slash", command: { name: "tasks", arg: "kill bg-1" } });
  });

  it("parses /memory, /export, /clear and /diff", () => {
    expect(parseInput("/memory")).toEqual({ kind: "slash", command: { name: "memory" } });
    expect(parseInput("/memory edit")).toEqual({ kind: "slash", command: { name: "memory", arg: "edit" } });
    expect(parseInput("/export notes.md")).toEqual({ kind: "slash", command: { name: "export", arg: "notes.md" } });
    expect(parseInput("/clear")).toEqual({ kind: "slash", command: { name: "clear" } });
    expect(parseInput("/diff")).toEqual({ kind: "slash", command: { name: "diff" } });
  });
});

describe("parseInput v3 additions", () => {
  it("parses the new management commands", () => {
    expect(parseInput("/backtrack")).toEqual({ kind: "slash", command: { name: "backtrack" } });
    expect(parseInput("/skills")).toEqual({ kind: "slash", command: { name: "skills" } });
    expect(parseInput("/init")).toEqual({ kind: "slash", command: { name: "init" } });
    expect(parseInput("/doctor")).toEqual({ kind: "slash", command: { name: "doctor" } });
    expect(parseInput("/vim")).toEqual({ kind: "slash", command: { name: "vim" } });
  });
});

describe("parseInput round-8 alignment additions", () => {
  it("parses /clear with a label, /compact with focus, /memory edit <file>", () => {
    expect(parseInput("/clear refactor attempt")).toEqual({
      kind: "slash",
      command: { name: "clear", arg: "refactor attempt" },
    });
    expect(parseInput("/compact focus on the auth bug")).toEqual({
      kind: "slash",
      command: { name: "compact", arg: "focus on the auth bug" },
    });
    expect(parseInput("/memory edit candidates.jsonl")).toEqual({
      kind: "slash",
      command: { name: "memory", arg: "edit candidates.jsonl" },
    });
    expect(parseInput("/mouse")).toEqual({ kind: "slash", command: { name: "mouse" } });
  });
});

describe("parseInput MCP-prompt additions", () => {
  it("parses /prompts as a no-arg command", () => {
    expect(parseInput("/prompts")).toEqual({ kind: "slash", command: { name: "prompts" } });
  });

  it("routes /mcp:<server>:<prompt> through the unknown resolver (dynamic command)", () => {
    // The colon-namespaced name is not a built-in keyword, so it parses as an
    // unknown command whose raw the app re-resolves against live MCP prompts.
    expect(parseInput("/mcp:fake:greet world")).toEqual({
      kind: "slash",
      command: { name: "unknown", raw: "/mcp:fake:greet world" },
    });
  });

  it("keeps /mcp itself a distinct no-arg command", () => {
    expect(parseInput("/mcp")).toEqual({ kind: "slash", command: { name: "mcp" } });
  });
});
