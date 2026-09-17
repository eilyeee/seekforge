/**
 * `/compact` and `/compact <focus>`: compact a stored session now, through the
 * same hooks a run fires. Core wraps a manual compaction in preCompact (reason
 * "manual", which may cancel it) and postCompact when it is given the hooks;
 * without them a configured preCompact hook would be skipped for exactly the
 * compactions the user asked for.
 */

import {
  compactSessionNow,
  createPromptHookEvaluator,
  llmCompactSessionNow,
  type ChatProvider,
  type CompactionBlocked,
  type CompactionHookOptions,
  type HookConfig,
} from "@seekforge/core";
import { inertLine, kfmt } from "./format.js";
import { t } from "./strings.js";

export type CompactCounts = { droppedTurns: number; beforeTokens: number; afterTokens: number; notices?: string[] };
export type CompactOutcome = CompactCounts | CompactionBlocked | null;
export type CompactNotice = { text: string; tone?: "dim" | "error" };

export type CompactRequest = {
  projectPath: string;
  sessionId: string;
  /** Present: the model summarizes the dropped middle, steered by it. */
  focus?: string;
  /** The config's hooks merged with the enabled plugins' (the run path's set). */
  hooks: HookConfig | undefined;
  /** The provider for `model` (undefined = the session's); summaries and prompt hooks use it. */
  provider: (model?: string) => ChatProvider;
  /** A hook that failed to run; the compaction goes on. */
  onHookError: (message: string) => void;
};

const HOOK_NOTICE_CHARS = 300;

export function isCompactionBlocked(outcome: CompactOutcome): outcome is CompactionBlocked {
  return outcome !== null && "blocked" in outcome && outcome.blocked === true;
}

export async function compactStoredSession(request: CompactRequest): Promise<CompactOutcome> {
  const hookOptions: CompactionHookOptions = {
    ...(request.hooks ? { hooks: request.hooks } : {}),
    onError: request.onHookError,
  };
  if (request.focus !== undefined) {
    // Prompt hooks are evaluated with the summarizing provider (core's default).
    return llmCompactSessionNow(request.projectPath, request.sessionId, request.provider(), request.focus, hookOptions);
  }
  return compactSessionNow(request.projectPath, request.sessionId, undefined, {
    ...hookOptions,
    evaluate: createPromptHookEvaluator((model) => request.provider(model)),
  });
}

/** The transcript lines for one manual compaction's outcome. */
export function compactOutcomeNotices(outcome: CompactOutcome, focused: boolean): CompactNotice[] {
  if (outcome === null) {
    return [
      {
        text: focused
          ? "nothing to compact — the session is still short (or the model call failed)"
          : "nothing to compact — the session is still short",
      },
    ];
  }
  // Hook messages are the hook's output, shown as one inert line each.
  const hookLines = (outcome.notices ?? []).map(
    (notice): CompactNotice => ({ text: `${t("compact.hookSays")} ${inertLine(notice, HOOK_NOTICE_CHARS)}` }),
  );
  if (isCompactionBlocked(outcome)) {
    return [
      ...hookLines,
      { text: `${t("compact.blocked")} ${inertLine(outcome.reason, HOOK_NOTICE_CHARS)}`, tone: "error" },
    ];
  }
  const counts = `dropped ${outcome.droppedTurns} earlier messages, ${kfmt(outcome.beforeTokens)} → ${kfmt(outcome.afterTokens)} tokens`;
  return [
    ...hookLines,
    {
      text: focused ? `compacted (LLM, focused): ${counts}` : `compacted: ${counts} (applies on the next message)`,
    },
  ];
}
