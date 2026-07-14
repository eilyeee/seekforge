import type { TokenUsage, ToolResult } from "@seekforge/shared";
import { describe, expect, it } from "vitest";
import {
  addUsage,
  canonicalArgs,
  classifyAutoGateResult,
  commandResultSatisfiesGate,
  selectAutoGate,
  subtractUsage,
} from "../../src/agent/loop-logic.js";

const usage = (n: number): TokenUsage => ({
  promptTokens: n,
  completionTokens: n * 2,
  cacheHitTokens: n * 3,
  costUsd: n * 10,
});

describe("loop usage arithmetic", () => {
  it("adds and subtracts every usage field without mutating inputs", () => {
    const a = usage(2);
    const b = usage(3);
    expect(addUsage(a, b)).toEqual(usage(5));
    expect(subtractUsage(b, a)).toEqual(usage(1));
    expect(a).toEqual(usage(2));
    expect(b).toEqual(usage(3));
  });
});

describe("canonicalArgs", () => {
  it("sorts nested object keys while preserving array order", () => {
    expect(canonicalArgs('{"z":{"b":2,"a":1},"a":[{"d":4,"c":3},2]}')).toBe(
      '{"a":[{"c":3,"d":4},2],"z":{"a":1,"b":2}}',
    );
  });

  it("keeps malformed input unchanged and treats missing input as empty", () => {
    expect(canonicalArgs("{bad")).toBe("{bad");
    expect(canonicalArgs(undefined)).toBe("");
    expect(canonicalArgs("")).toBe("");
  });
});

describe("verify/lint gate decisions", () => {
  it("accepts only a successful foreground invocation of the configured command", () => {
    const pass: ToolResult = { ok: true, data: { exitCode: 0 }, meta: { command: "pnpm test" } };
    expect(commandResultSatisfiesGate(pass, " pnpm test ")).toBe(true);
    expect(commandResultSatisfiesGate({ ...pass, data: { exitCode: 1 } }, "pnpm test")).toBe(false);
    expect(commandResultSatisfiesGate({ ...pass, data: { taskId: "bg" } }, "pnpm test")).toBe(false);
    expect(commandResultSatisfiesGate({ ...pass, meta: { command: "pnpm test; echo done" } }, "pnpm test")).toBe(false);
    expect(commandResultSatisfiesGate(pass, "   ")).toBe(false);
  });

  it("selects enabled non-blank auto gates", () => {
    expect(selectAutoGate("verify", {
      verifyCommand: " pnpm test ", autoVerify: true, autoLint: true,
    })).toEqual({ kind: "verify", command: "pnpm test", notice: "Auto-verifying changes: pnpm test" });
    expect(selectAutoGate("lint", {
      lintCommand: "pnpm lint", autoVerify: true, autoLint: false,
    })).toBeNull();
    expect(selectAutoGate("review", { autoVerify: true, autoLint: true })).toBeNull();
  });

  it("classifies pass, failure, and execution errors with gate-specific followups", () => {
    expect(classifyAutoGateResult(
      { kind: "verify", command: "pnpm test" },
      { exitCode: 0, output: "" },
    )).toMatchObject({ ranSinceEdit: true, retryAfterEdit: false, followup: expect.stringContaining("PASSED") });

    const failed = classifyAutoGateResult(
      { kind: "lint", command: "pnpm lint" },
      { exitCode: 2, output: "bad lint" },
    );
    expect(failed).toMatchObject({ ranSinceEdit: true, retryAfterEdit: true });
    expect(failed.followup).toContain("Auto-lint `pnpm lint` FAILED (exit 2)");
    expect(failed.followup).toContain("bad lint");

    expect(classifyAutoGateResult(
      { kind: "verify", command: "pnpm test" },
      { error: new Error("spawn failed") },
    )).toEqual({
      ranSinceEdit: false,
      retryAfterEdit: false,
      followup:
        "[harness] Auto-verify `pnpm test` could not run (spawn failed). " +
        "Run it yourself with run_command, fix any failures, then finish.",
    });
  });
});
