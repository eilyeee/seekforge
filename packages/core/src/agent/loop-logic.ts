import type { ToolResult } from "@seekforge/shared";
import { commandInvokes } from "../tools/run-command.js";
import type { FinalizeKind } from "./finalize.js";

// TokenUsage arithmetic lives in @seekforge/shared (beside the type) so core and
// desktop share one implementation. Re-exported here to keep existing
// `from "./loop-logic.js"` import sites working.
export { addUsage, subtractUsage, ZERO_USAGE } from "@seekforge/shared";

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

/** Detects a repeated suffix cycle (A→A, A→B→A→B, up to maxPeriod). */
export function detectActionCycle(history: readonly string[], maxPeriod = 4): number | null {
  const boundedMax = Math.max(1, Math.min(Math.floor(maxPeriod), 8));
  for (let period = 1; period <= boundedMax; period++) {
    if (history.length < period * 2) continue;
    let matches = true;
    for (let offset = 0; offset < period; offset++) {
      if (history[history.length - 1 - offset] !== history[history.length - 1 - period - offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return period;
  }
  return null;
}

/** Records a comparable progress fingerprint; unknown workspace state breaks the cycle history. */
export function recordProgressFingerprint(
  history: string[],
  fingerprint: string | null,
  maxHistory = 8,
): number | null {
  if (fingerprint === null) {
    history.length = 0;
    return null;
  }
  history.push(fingerprint);
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
  return detectActionCycle(history);
}

/** Only a successful foreground command can satisfy a verify/lint gate. */
export function commandResultSatisfiesGate(result: ToolResult, configuredCommand?: string): boolean {
  const command = configuredCommand?.trim();
  const exitCode = (result.data as { exitCode?: unknown } | undefined)?.exitCode;
  return Boolean(
    result.ok && exitCode === 0 && result.meta?.command && command && commandInvokes(result.meta.command, command),
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
  const instruction =
    gate.kind === "verify"
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
