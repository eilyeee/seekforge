import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSessionMeta } from "@seekforge/core";
import {
  loadJsonSchemaFlag,
  parseAgentsFlag,
  resolveMcpServers,
  resolvePromptFlags,
  resolveSessionFlags,
  RunSetupError,
} from "../run-setup.js";
import { buildResultEnvelope } from "../output-format.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-run-setup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setupError(fn: () => unknown): RunSetupError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RunSetupError) return error;
    throw error;
  }
  throw new Error("expected a RunSetupError");
}

describe("resolvePromptFlags", () => {
  it("reads prompt files", () => {
    writeFileSync(join(dir, "sys.md"), "SYSTEM");
    writeFileSync(join(dir, "add.md"), "EXTRA");
    expect(resolvePromptFlags({ systemPromptFile: join(dir, "sys.md") }, dir)).toEqual({ systemPrompt: "SYSTEM" });
    expect(resolvePromptFlags({ appendSystemPromptFile: join(dir, "add.md") }, dir)).toEqual({
      appendSystemPrompt: "EXTRA",
    });
  });

  it("appends to a replacement prompt instead of dropping the addition", () => {
    expect(resolvePromptFlags({ systemPrompt: "S", appendSystemPrompt: "A" }, dir)).toEqual({ systemPrompt: "S\n\nA" });
    const styled = resolvePromptFlags({ systemPrompt: "S", outputStyle: "concise" }, dir);
    expect(styled.systemPrompt?.startsWith("S\n\n")).toBe(true);
    expect(styled.appendSystemPrompt).toBeUndefined();
    const plain = resolvePromptFlags({ outputStyle: "concise", appendSystemPrompt: "A" }, dir);
    expect(plain.appendSystemPrompt?.endsWith("\n\nA")).toBe(true);
  });

  it("refuses a text flag together with its file flag, and unreadable files", () => {
    expect(setupError(() => resolvePromptFlags({ systemPrompt: "", systemPromptFile: "x" }, dir)).message).toContain(
      "--system-prompt",
    );
    expect(
      setupError(() => resolvePromptFlags({ appendSystemPrompt: "a", appendSystemPromptFile: "x" }, dir)).message,
    ).toContain("--append-system-prompt-file");
    const missing = setupError(() => resolvePromptFlags({ systemPromptFile: join(dir, "nope") }, dir));
    expect(missing.message).toContain(join(dir, "nope"));
    expect(missing.hint).toContain("ENOENT");
    expect(setupError(() => resolvePromptFlags({ outputStyle: "no-such-style" }, dir)).message).toContain(
      "no-such-style",
    );
  });

  it("bounds prompt files", () => {
    writeFileSync(join(dir, "big.md"), "x".repeat(1024 * 1024 + 1));
    expect(setupError(() => resolvePromptFlags({ systemPromptFile: join(dir, "big.md") }, dir)).hint).toContain(
      "exceeds",
    );
  });
});

describe("loadJsonSchemaFlag", () => {
  it("parses inline and file schemas", () => {
    expect(loadJsonSchemaFlag({})).toBeUndefined();
    expect(loadJsonSchemaFlag({ jsonSchema: '{"type":"object"}' })).toEqual({ type: "object" });
    writeFileSync(join(dir, "s.json"), '{"type":"array"}');
    expect(loadJsonSchemaFlag({ jsonSchemaFile: join(dir, "s.json") })).toEqual({ type: "array" });
  });

  it("rejects bad input before any run", () => {
    expect(setupError(() => loadJsonSchemaFlag({ jsonSchema: "{" })).message).toContain("invalid --json-schema");
    expect(setupError(() => loadJsonSchemaFlag({ jsonSchema: '{"if":{}}' })).message).toContain('"if"');
    expect(setupError(() => loadJsonSchemaFlag({ jsonSchema: "{}", jsonSchemaFile: "x" })).message).toContain(
      "--json-schema-file",
    );
  });
});

describe("parseAgentsFlag", () => {
  it("returns nothing without the flag and definitions with it", () => {
    expect(parseAgentsFlag(undefined)).toEqual([]);
    expect(parseAgentsFlag('{"a":{"description":"d","prompt":"p"}}').map((d) => d.id)).toEqual(["a"]);
  });

  it("turns parse errors into a setup error with the expected shape as a hint", () => {
    const error = setupError(() => parseAgentsFlag('{"a":{"description":"d"}}'));
    expect(error.message).toContain('"prompt" is required');
    expect(error.hint).toContain("<agent-id>");
  });
});

describe("resolveSessionFlags", () => {
  const meta = (id: string, createdAt: string, mode: "ask" | "edit" = "edit") =>
    writeSessionMeta(dir, { id, task: "t", mode, status: "completed", createdAt, updatedAt: createdAt });

  it("resolves --resume and --continue, keeping the stored mode", () => {
    meta("old", "2026-01-01T00:00:00.000Z", "ask");
    meta("new", "2026-02-01T00:00:00.000Z");
    expect(resolveSessionFlags(dir, {})).toEqual({});
    expect(resolveSessionFlags(dir, { continueLast: true })).toEqual({ resumeSessionId: "new", resumeMode: "edit" });
    expect(resolveSessionFlags(dir, { continueLast: true, resumeSessionId: "old" })).toEqual({
      resumeSessionId: "old",
      resumeMode: "ask",
    });
    expect(resolveSessionFlags(dir, { resumeSessionId: "old", forkSession: true })).toEqual({
      resumeSessionId: "old",
      resumeMode: "ask",
      fork: true,
    });
  });

  it("fails loudly on sessions that do not exist", () => {
    expect(setupError(() => resolveSessionFlags(dir, { continueLast: true })).message).toContain("no previous session");
    expect(setupError(() => resolveSessionFlags(dir, { resumeSessionId: "ghost" })).message).toContain("ghost");
    expect(setupError(() => resolveSessionFlags(dir, { forkSession: true })).message).toContain("--fork-session");
  });

  it("validates --session-id and keeps it for a new session only", () => {
    meta("taken", "2026-01-01T00:00:00.000Z");
    const uuid = "0b7e1b52-8f7c-4c61-9d5e-2d0f2f1b8a10";
    expect(resolveSessionFlags(dir, { sessionId: uuid })).toEqual({ newSessionId: uuid });
    expect(setupError(() => resolveSessionFlags(dir, { sessionId: "has space" })).message).toContain("--session-id");
    expect(setupError(() => resolveSessionFlags(dir, { sessionId: "../up" })).message).toContain("--session-id");
    const exists = setupError(() => resolveSessionFlags(dir, { sessionId: "taken" }));
    expect(exists.message).toContain("already exists");
    expect(exists.hint).toContain("--resume taken");
    for (const flags of [{ continueLast: true }, { resumeSessionId: "taken" }, { forkSession: true }]) {
      expect(setupError(() => resolveSessionFlags(dir, { sessionId: uuid, ...flags })).message).toContain(
        "cannot be combined",
      );
    }
  });
});

describe("resolveMcpServers", () => {
  const config = { mcpServers: { a: { command: "a" }, b: { command: "b" } } };

  it("merges, replaces or clears servers", () => {
    mkdirSync(join(dir, "m"));
    const file = join(dir, "m", "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { b: { command: "B" }, c: { command: "c" } } }));
    expect(resolveMcpServers(config, {})).toBe(config);
    expect(resolveMcpServers(config, { mcpConfig: file }).mcpServers).toEqual({
      a: { command: "a" },
      b: { command: "B" },
      c: { command: "c" },
    });
    expect(Object.keys(resolveMcpServers(config, { mcpConfig: file, strictMcpConfig: true }).mcpServers ?? {})).toEqual(
      ["b", "c"],
    );
    expect(resolveMcpServers(config, { strictMcpConfig: true }).mcpServers).toEqual({});
    expect(setupError(() => resolveMcpServers(config, { mcpConfig: join(dir, "nope.json") })).message).toContain(
      "--mcp-config",
    );
  });
});

describe("result envelope extras", () => {
  const report = {
    summary: "done",
    changedFiles: [],
    commandsRun: [],
    verification: "none",
    usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 2, costUsd: 0.5 },
  };

  it("adds structured_output, the extra usage and the worktree", () => {
    const envelope = buildResultEnvelope({
      report,
      sessionId: "s",
      numTurns: 1,
      durationMs: 1,
      structuredOutput: { ok: true },
      extraUsage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.25 },
      worktree: { path: "/w", branch: "seekforge/run-x" },
    });
    expect(envelope).toMatchObject({
      subtype: "success",
      structured_output: { ok: true },
      total_cost_usd: 0.75,
      usage: { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 2 },
      worktree: { path: "/w", branch: "seekforge/run-x" },
    });
  });

  it("reports structured-output failure with Claude Code's subtype", () => {
    const envelope = buildResultEnvelope({
      report,
      sessionId: "s",
      numTurns: 1,
      durationMs: 1,
      outcome: { kind: "structured_output", message: "never validated" },
    });
    expect(envelope).toMatchObject({
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: ["never validated"],
      result: "done",
    });
    expect(envelope).not.toHaveProperty("structured_output");
  });
});
