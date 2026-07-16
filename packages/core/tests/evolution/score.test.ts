import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSession } from "../../src/evolution/index.js";
import { failedCall, makeWorkspace, okCall, runCommandCall, writeSessionFixture } from "./helpers.js";

describe("scoreSession", () => {
  it("throws when the session does not exist", () => {
    const ws = makeWorkspace();
    expect(() => scoreSession(ws, "nope")).toThrow(/session not found: nope/);
  });

  it("scores a clean verified edit session at 100 with no notes", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      status: "completed",
      mode: "edit",
      assistantTurns: 3,
      costUsd: 0.0123,
      toolCalls: [
        okCall("read_file", { path: "src/a.ts" }),
        okCall("apply_patch", { path: "src/a.ts" }),
        runCommandCall("pnpm test"),
      ],
    });

    const result = scoreSession(ws, "sess1");
    expect(result.score).toBe(100);
    expect(result.notes).toEqual([]);
    expect(result.metrics).toEqual({
      turns: 3,
      toolCalls: 3,
      failedToolCalls: 0,
      retriedCommands: 0,
      costUsd: 0.0123,
      verificationRan: true,
      status: "completed",
    });
  });

  it("deducts 25 for a failed session and notes it", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      status: "failed",
      mode: "edit",
      assistantTurns: 2,
      toolCalls: [runCommandCall("pnpm build")],
    });

    const result = scoreSession(ws, "sess1");
    expect(result.score).toBe(75);
    expect(result.notes).toEqual(["session status is failed: -25"]);
  });

  it("deducts 25 for a cancelled session", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, { status: "cancelled", mode: "ask", assistantTurns: 1, toolCalls: [] });
    const result = scoreSession(ws, "sess1");
    expect(result.score).toBe(75);
    expect(result.metrics.status).toBe("cancelled");
  });

  it("deducts 3 per failed tool call, capped at 30", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      mode: "edit",
      assistantTurns: 2,
      toolCalls: [
        runCommandCall("pnpm test"),
        failedCall("read_file", "not_found"),
        failedCall("apply_patch", "no_match"),
      ],
    });
    const twoFailed = scoreSession(ws, "sess1");
    expect(twoFailed.score).toBe(94);
    expect(twoFailed.notes).toEqual(["2 failed tool call(s): -6"]);
    expect(twoFailed.metrics.failedToolCalls).toBe(2);

    writeSessionFixture(ws, {
      sessionId: "sess2",
      mode: "edit",
      assistantTurns: 2,
      toolCalls: [
        runCommandCall("pnpm test"),
        ...Array.from({ length: 12 }, () => failedCall("apply_patch", "no_match")),
      ],
    });
    const capped = scoreSession(ws, "sess2");
    expect(capped.score).toBe(70); // 12*3=36 capped at 30
    expect(capped.notes).toEqual(["12 failed tool call(s): -30"]);
  });

  it("deducts 15 when an edit session ran no test/lint/build command", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      mode: "edit",
      assistantTurns: 2,
      toolCalls: [okCall("apply_patch", { path: "src/a.ts" }), runCommandCall("ls -la")],
    });
    const result = scoreSession(ws, "sess1");
    expect(result.score).toBe(85);
    expect(result.metrics.verificationRan).toBe(false);
    expect(result.notes).toEqual(["edit session ran no test/lint/build command: -15"]);
  });

  it("does not require verification in ask mode", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, { mode: "ask", assistantTurns: 2, toolCalls: [okCall("read_file")] });
    const result = scoreSession(ws, "sess1");
    expect(result.score).toBe(100);
    expect(result.metrics.verificationRan).toBe(false);
  });

  it("deducts 1 per turn beyond 10, capped at 15", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      mode: "edit",
      assistantTurns: 14,
      toolCalls: [runCommandCall("pnpm test")],
    });
    const over = scoreSession(ws, "sess1");
    expect(over.score).toBe(96);
    expect(over.notes).toEqual(["14 turns (over 10): -4"]);

    writeSessionFixture(ws, {
      sessionId: "sess2",
      mode: "edit",
      assistantTurns: 40,
      toolCalls: [runCommandCall("pnpm test")],
    });
    const capped = scoreSession(ws, "sess2");
    expect(capped.score).toBe(85);
    expect(capped.notes).toEqual(["40 turns (over 10): -15"]);
  });

  it("counts retried (repeated) run_command invocations", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      mode: "edit",
      assistantTurns: 2,
      toolCalls: [
        runCommandCall("pnpm test", false),
        runCommandCall("pnpm test"),
        runCommandCall("pnpm test"),
        runCommandCall("pnpm lint"),
      ],
    });
    const result = scoreSession(ws, "sess1");
    expect(result.metrics.retriedCommands).toBe(2);
    expect(result.metrics.toolCalls).toBe(4);
  });

  it("combines deductions and clamps at 0", () => {
    const ws = makeWorkspace();
    writeSessionFixture(ws, {
      status: "failed",
      mode: "edit",
      assistantTurns: 40,
      toolCalls: Array.from({ length: 15 }, () => failedCall("run_command", "command_failed", { command: "ls" })),
    });
    const result = scoreSession(ws, "sess1");
    // 100 - 25 (failed) - 30 (cap) - 15 (no verification) - 15 (turns cap) = 15
    expect(result.score).toBe(15);
    expect(result.notes).toHaveLength(4);
  });

  it("tolerates missing messages/tool-calls files and corrupt lines", () => {
    const ws = makeWorkspace();
    const sessionId = writeSessionFixture(ws, { mode: "ask", assistantTurns: 1, toolCalls: [] });
    const dir = path.join(ws, ".seekforge", "sessions", sessionId);
    fs.rmSync(path.join(dir, "messages.jsonl"));
    fs.appendFileSync(path.join(dir, "tool-calls.jsonl"), "{not json\n");
    const result = scoreSession(ws, sessionId);
    expect(result.metrics.turns).toBe(0);
    expect(result.metrics.toolCalls).toBe(0);
  });
});
