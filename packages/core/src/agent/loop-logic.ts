import type { TokenUsage, ToolResult } from "@seekforge/shared";
import { commandInvokes } from "../tools/run-command.js";
import type { FinalizeKind } from "./finalize.js";

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  costUsd: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function subtractUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens - b.promptTokens,
    completionTokens: a.completionTokens - b.completionTokens,
    cacheHitTokens: a.cacheHitTokens - b.cacheHitTokens,
    costUsd: a.costUsd - b.costUsd,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Order-independent canonical form of a tool call's arguments JSON. */
export function canonicalArgs(argumentsJson: string | undefined): string {
  if (!argumentsJson) return "";
  try {
    return JSON.stringify(sortKeys(JSON.parse(argumentsJson)));
  } catch {
    return argumentsJson;
  }
}

/** Only a successful foreground command can satisfy a verify/lint gate. */
export function commandResultSatisfiesGate(result: ToolResult, configuredCommand?: string): boolean {
  const command = configuredCommand?.trim();
  const exitCode = (result.data as { exitCode?: unknown } | undefined)?.exitCode;
  return Boolean(
    result.ok &&
    exitCode === 0 &&
    result.meta?.command &&
    command &&
    commandInvokes(result.meta.command, command),
  );
}

export type AutoGateKind = Extract<FinalizeKind, "verify" | "lint">;

export type AutoGate = {
  kind: AutoGateKind;
  command: string;
  notice: string;
};

export function selectAutoGate(
  kind: FinalizeKind,
  options: {
    verifyCommand?: string;
    lintCommand?: string;
    autoVerify: boolean;
    autoLint: boolean;
  },
): AutoGate | null {
  if (kind === "verify" && options.autoVerify) {
    const command = options.verifyCommand?.trim();
    if (command) return { kind, command, notice: `Auto-verifying changes: ${command}` };
  }
  if (kind === "lint" && options.autoLint) {
    const command = options.lintCommand?.trim();
    if (command) return { kind, command, notice: `Auto-linting changes: ${command}` };
  }
  return null;
}

export type AutoGateResult = {
  ranSinceEdit: boolean;
  retryAfterEdit: boolean;
  followup: string;
};

export function classifyAutoGateResult(
  gate: Pick<AutoGate, "kind" | "command">,
  outcome: { exitCode: number; output: string } | { error: unknown },
): AutoGateResult {
  const label = gate.kind === "verify" ? "verify" : "lint";
  if ("error" in outcome) {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return {
      ranSinceEdit: false,
      retryAfterEdit: false,
      followup:
        `[harness] Auto-${label} \`${gate.command}\` could not run (${detail}). ` +
        "Run it yourself with run_command, fix any failures, then finish.",
    };
  }
  if (outcome.exitCode === 0) {
    return {
      ranSinceEdit: true,
      retryAfterEdit: false,
      followup:
        `[harness] Auto-${label} \`${gate.command}\` PASSED (exit 0). If the task is fully complete, ` +
        "finish now; otherwise keep working.",
    };
  }
  const instruction = gate.kind === "verify"
    ? "Diagnose and fix the cause, then finish — do not claim success until it passes."
    : "Fix the reported lint issues, then finish — do not claim success until it passes.";
  return {
    ranSinceEdit: true,
    retryAfterEdit: true,
    followup:
      `[harness] Auto-${label} \`${gate.command}\` FAILED (exit ${outcome.exitCode}). Output:\n${outcome.output}\n` +
      instruction,
  };
}
