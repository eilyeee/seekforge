// Output-format selection for run/ask/-p. Three modes:
//   text         — human-readable terminal stream (default)
//   json         — one final JSON object at the end (summary, changedFiles, …)
//   stream-json   — one AgentEvent per line (JSONL), the existing --json behavior
//
// `--json` is kept as a back-compat alias for `--output-format stream-json`
// (that is exactly what the old flag emitted: one event per line).

import type { AgentEvent, FinalReport } from "@seekforge/shared";

export type OutputFormat = "text" | "json" | "stream-json";

/**
 * Resolves the effective output format from the new --output-format flag and
 * the legacy --json alias. Throws on an unknown --output-format value so the
 * CLI can report it cleanly. `--json` (legacy) maps to stream-json.
 */
export function resolveOutputFormat(opts: { outputFormat?: string; json?: boolean }): OutputFormat {
  if (opts.outputFormat !== undefined) {
    const v = opts.outputFormat.toLowerCase();
    if (v === "text" || v === "json" || v === "stream-json") return v;
    throw new Error(`invalid --output-format "${opts.outputFormat}" (expected text | json | stream-json)`);
  }
  if (opts.json) return "stream-json";
  return "text";
}

/**
 * Builds the single final JSON object emitted by `--output-format json` from
 * the session's final report plus the session id. Pure so it is unit-testable.
 */
export function buildJsonResult(report: FinalReport, sessionId: string | undefined): Record<string, unknown> {
  return {
    sessionId: sessionId ?? null,
    summary: report.summary,
    changedFiles: report.changedFiles,
    commandsRun: report.commandsRun,
    verification: report.verification,
    usage: report.usage,
  };
}

/** True for formats that must not interleave any human/streamed text on stdout. */
export function isMachineFormat(format: OutputFormat): boolean {
  return format === "json" || format === "stream-json";
}

/** Narrows an AgentEvent to the final report event, for json accumulation. */
export function finalReportOf(event: AgentEvent): FinalReport | null {
  return event.type === "session.completed" ? event.report : null;
}
