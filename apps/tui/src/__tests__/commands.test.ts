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
