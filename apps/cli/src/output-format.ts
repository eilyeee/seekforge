// Output-format selection for run/ask/-p. Modes:
//   text             — human-readable terminal stream (default)
//   json             — one final JSON object at the end, shaped like Claude
//                      Code's `claude -p --output-format json` result envelope
//   stream-json      — Claude-style SDK message envelopes, one per line (JSONL):
//                      a leading {type:"system",subtype:"init"}, then
//                      {type:"assistant"} / {type:"user"} per turn, and a final
//                      {type:"result"} (same shape as `json`).
//   stream-json-raw  — the OLD behavior: one raw internal AgentEvent per line.
//                      Kept for back-compat / debugging.
//
// `--json` is kept as a back-compat alias for `--output-format stream-json`.
//
// CLAUDE COMPATIBILITY
// --------------------
// Tooling written for `claude -p --output-format json` parses a result envelope:
//   { type:"result", subtype, is_error, result, session_id, num_turns,
//     duration_ms, total_cost_usd, usage:{ input_tokens, output_tokens, ... } }
// We map our data onto exactly those field names (snake_case) so those consumers
// work unchanged, and we keep SeekForge-specific extras (changedFiles,
// commandsRun, verification) as additional keys on the same object — Claude
// consumers ignore unknown keys.
//
// For stream-json the top-level `type` taxonomy (system | assistant | user |
// result) and `session_id` match Claude's stream so stream consumers work; the
// inner `message` shape is a pragmatic subset of the Anthropic SDK schema.

import type { AgentEvent, FinalReport, TokenUsage } from "@seekforge/shared";

export type OutputFormat = "text" | "json" | "stream-json" | "stream-json-raw";

/**
 * Resolves the effective output format from the new --output-format flag and
 * the legacy --json alias. Throws on an unknown --output-format value so the
 * CLI can report it cleanly. `--json` (legacy) maps to stream-json.
 */
export function resolveOutputFormat(opts: { outputFormat?: string; json?: boolean }): OutputFormat {
  if (opts.outputFormat !== undefined) {
    const v = opts.outputFormat.toLowerCase();
    if (v === "text" || v === "json" || v === "stream-json" || v === "stream-json-raw") return v;
    throw new Error(
      `invalid --output-format "${opts.outputFormat}" (expected text | json | stream-json | stream-json-raw)`,
    );
  }
  if (opts.json) return "stream-json";
  return "text";
}

/** True for formats that must not interleave any human/streamed text on stdout. */
export function isMachineFormat(format: OutputFormat): boolean {
  return format === "json" || format === "stream-json" || format === "stream-json-raw";
}

/** Narrows an AgentEvent to the final report event, for json accumulation. */
export function finalReportOf(event: AgentEvent): FinalReport | null {
  return event.type === "session.completed" ? event.report : null;
}

// ---------------------------------------------------------------------------
// Result envelope (Claude `--output-format json` compatible)
// ---------------------------------------------------------------------------

/** Claude-compatible `usage` block (snake_case), built from our TokenUsage. */
export function buildUsage(usage: TokenUsage): Record<string, number> {
  return {
    // Anthropic SDK names; map DeepSeek prompt/completion onto input/output.
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    // DeepSeek context-cache hits are a subset of prompt tokens; surface them
    // under the closest Anthropic-ish name plus a SeekForge-specific alias.
    cache_read_input_tokens: usage.cacheHitTokens,
    cache_hit_tokens: usage.cacheHitTokens,
  };
}

/** "How did this run end" → the Claude result-envelope subtype + is_error. */
export type ResultOutcome =
  | { kind: "success" }
  | { kind: "max_turns" }
  | { kind: "error"; message?: string };

/** Maps an AgentEvent error code (session.failed) to a result outcome. */
export function outcomeFromErrorCode(code: string, message?: string): ResultOutcome {
  if (code === "max_turns_exceeded") return { kind: "max_turns" };
  return { kind: "error", ...(message !== undefined ? { message } : {}) };
}

export type ResultEnvelopeInput = {
  /** The completed run's report (present on success). */
  report?: FinalReport;
  sessionId: string | undefined;
  /** Assistant turns observed in the run (model messages that produced text). */
  numTurns: number;
  /** Wall-clock duration of the run, measured CLI-side. */
  durationMs: number;
  /** Outcome: success | max_turns | error. Defaults to success when a report exists. */
  outcome?: ResultOutcome;
};

/**
 * Builds the Claude-compatible result envelope emitted by `--output-format json`
 * (and as the final line of `stream-json`). Pure so it is unit-testable.
 *
 * Field mapping from SeekForge data:
 *   summary           → result
 *   sessionId         → session_id
 *   report.usage.*    → usage.{input_tokens,output_tokens,...} + total_cost_usd
 *   error-code        → subtype + is_error
 * SeekForge extras (changedFiles, commandsRun, verification) ride along as
 * additional keys; Claude consumers ignore them.
 */
export function buildResultEnvelope(input: ResultEnvelopeInput): Record<string, unknown> {
  const { report, sessionId, numTurns, durationMs } = input;
  const outcome: ResultOutcome = input.outcome ?? { kind: "success" };

  const subtype =
    outcome.kind === "success" ? "success" : outcome.kind === "max_turns" ? "error_max_turns" : "error";
  const isError = outcome.kind !== "success";

  // `result` is the final summary text; on a failed run with no report, surface
  // the error message (Claude puts the error string in `result` for errors).
  const result =
    report?.summary ?? (outcome.kind === "error" ? (outcome.message ?? "") : "");

  const usage = report?.usage;

  const envelope: Record<string, unknown> = {
    type: "result",
    subtype,
    is_error: isError,
    result,
    session_id: sessionId ?? null,
    num_turns: numTurns,
    duration_ms: durationMs,
    total_cost_usd: usage?.costUsd ?? 0,
    usage: usage ? buildUsage(usage) : {},
  };

  // SeekForge-specific extras (ignored by Claude consumers).
  if (report) {
    envelope.changedFiles = report.changedFiles;
    envelope.commandsRun = report.commandsRun;
    envelope.verification = report.verification;
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// stream-json: AgentEvent → Claude SDK message envelopes
// ---------------------------------------------------------------------------

/**
 * Stateful mapper from our AgentEvent stream to Claude-style stream-json
 * envelopes. Construct one per run, call `map(event)` for each AgentEvent (it
 * returns 0+ envelope objects to print, one JSON line each), and call
 * `result({...})` at the end for the final result envelope.
 *
 * The leading {type:"system",subtype:"init"} is emitted lazily on the first
 * event that carries a session id (session.created) so it always includes the
 * real session_id, matching Claude's init message.
 */
export function createStreamJsonMapper(): {
  map: (event: AgentEvent) => Record<string, unknown>[];
  /** Build the trailing result envelope (call once, after the stream drains). */
  result: (input: ResultEnvelopeInput) => Record<string, unknown>;
  /** Assistant turns seen so far (text-producing model messages). */
  turns: () => number;
} {
  let sessionId: string | undefined;
  let initEmitted = false;
  let numTurns = 0;

  const emitInit = (out: Record<string, unknown>[]): void => {
    if (initEmitted) return;
    initEmitted = true;
    out.push({ type: "system", subtype: "init", session_id: sessionId ?? null });
  };

  const map = (event: AgentEvent): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    switch (event.type) {
      case "session.created": {
        sessionId = event.sessionId;
        emitInit(out);
        break;
      }
      case "model.message": {
        emitInit(out);
        numTurns++;
        out.push({
          type: "assistant",
          session_id: sessionId ?? null,
          message: { role: "assistant", content: [{ type: "text", text: event.content }] },
        });
        break;
      }
      case "tool.started": {
        emitInit(out);
        out.push({
          type: "assistant",
          session_id: sessionId ?? null,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: event.toolName, input: event.args }],
          },
        });
        break;
      }
      case "tool.completed": {
        emitInit(out);
        out.push({
          type: "user",
          session_id: sessionId ?? null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_name: event.toolName,
                is_error: event.result.ok === false,
                content: event.result,
              },
            ],
          },
        });
        break;
      }
      // Other internal events (steps, context, usage, retries, command output,
      // permission prompts) have no Claude-stream equivalent; drop them. The
      // raw stream is available under --output-format stream-json-raw.
      default:
        break;
    }
    return out;
  };

  return {
    map,
    result: (input) => buildResultEnvelope({ ...input, numTurns: input.numTurns || numTurns }),
    turns: () => numTurns,
  };
}
