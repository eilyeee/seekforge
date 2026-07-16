import { describe, expect, it } from "vitest";
import type { McpPromptRef } from "@seekforge/core";
import {
  findPromptByCommand,
  formatMcpPromptLines,
  mcpPromptCommandName,
  mcpPromptCommandSpecs,
  parseMcpPromptCommand,
  promptArgsFromText,
} from "../mcp-prompt-commands.js";

const PROMPTS: McpPromptRef[] = [
  { server: "Fake Server", name: "Greet User", description: "Greets a user.", arguments: [{ name: "who" }] },
  { server: "fake", name: "summarize" },
];

describe("mcpPromptCommandName", () => {
  it("sanitizes server and prompt into a colon-namespaced command", () => {
    expect(mcpPromptCommandName("Fake Server", "Greet User")).toBe("mcp:fake-server:greet-user");
  });
});

describe("mcpPromptCommandSpecs", () => {
  it("emits one tools-group spec per prompt, with [args] only when arguments are declared", () => {
    const specs = mcpPromptCommandSpecs(PROMPTS);
    expect(specs).toEqual([
      {
        name: "mcp:fake-server:greet-user",
        args: "[args]",
        summary: "(mcp fake-server) Greets a user.",
        group: "tools",
      },
      { name: "mcp:fake:summarize", summary: "(mcp fake) summarize", group: "tools" },
    ]);
  });

  it("skips prompts whose server or name sanitize to nothing", () => {
    expect(mcpPromptCommandSpecs([{ server: "!!!", name: "x" }])).toEqual([]);
    expect(mcpPromptCommandSpecs([{ server: "ok", name: "###" }])).toEqual([]);
  });

  it("assigns unique command names when normalization collides", () => {
    const colliding: McpPromptRef[] = [
      { server: "Build Server", name: "Run Check" },
      { server: "build-server", name: "run-check" },
      { server: "build server", name: "run-check-2" },
    ];
    expect(mcpPromptCommandSpecs(colliding).map((spec) => spec.name)).toEqual([
      "mcp:build-server:run-check",
      "mcp:build-server:run-check-2",
      "mcp:build-server:run-check-2-2",
    ]);
    expect(findPromptByCommand(colliding, "mcp:build-server:run-check")).toBe(colliding[0]);
    expect(findPromptByCommand(colliding, "mcp:build-server:run-check-2")).toBe(colliding[1]);
    expect(findPromptByCommand(colliding, "mcp:build-server:run-check-2-2")).toBe(colliding[2]);
  });
});

describe("parseMcpPromptCommand", () => {
  it("splits server and prompt on the first colon after the prefix", () => {
    expect(parseMcpPromptCommand("mcp:fake:greet-user")).toEqual({ server: "fake", prompt: "greet-user" });
  });

  it("returns null for non-mcp or malformed names", () => {
    expect(parseMcpPromptCommand("skill:foo")).toBeNull();
    expect(parseMcpPromptCommand("mcp:")).toBeNull();
    expect(parseMcpPromptCommand("mcp::x")).toBeNull();
    expect(parseMcpPromptCommand("mcp:server:")).toBeNull();
  });
});

describe("findPromptByCommand", () => {
  it("matches against the sanitized server/prompt pair", () => {
    expect(findPromptByCommand(PROMPTS, "mcp:fake-server:greet-user")).toBe(PROMPTS[0]);
    expect(findPromptByCommand(PROMPTS, "mcp:fake:summarize")).toBe(PROMPTS[1]);
  });

  it("returns null when nothing matches or it is not an mcp command", () => {
    expect(findPromptByCommand(PROMPTS, "mcp:fake:nope")).toBeNull();
    expect(findPromptByCommand(PROMPTS, "skill:x")).toBeNull();
  });
});

describe("promptArgsFromText", () => {
  it("binds trailing text to the first declared argument", () => {
    expect(promptArgsFromText(PROMPTS[0]!, "Ada")).toEqual({ who: "Ada" });
  });

  it("returns undefined with no arguments or empty text", () => {
    expect(promptArgsFromText(PROMPTS[1]!, "anything")).toBeUndefined();
    expect(promptArgsFromText(PROMPTS[0]!, "   ")).toBeUndefined();
  });
});

describe("formatMcpPromptLines", () => {
  it("lists each prompt with its command name plus a total", () => {
    expect(formatMcpPromptLines(PROMPTS)).toEqual([
      "/mcp:fake-server:greet-user [args]  Greets a user.",
      "/mcp:fake:summarize",
      "total: 2 prompts",
    ]);
  });

  it("returns a single notice when there are no prompts", () => {
    expect(formatMcpPromptLines([])).toEqual(["no MCP prompts available (no servers, or none expose prompts)"]);
  });
});
