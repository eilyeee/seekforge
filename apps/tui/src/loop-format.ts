/**
 * Pure LoopEvent → transcript-notice formatter for auto-loop mode. Mirrors the
 * CLI's formatLoopEvent (apps/cli/src/commands/loop.ts) and the desktop's
 * loopRows/status semantics (apps/desktop/src/lib/loop.ts), but emits plain
 * transcript notice descriptors so app.tsx can dispatch them straight into the
 * active tab. No Ink, no i18n, no I/O — unit-tested in loop-format.test.ts.
 *
 * Reuses the existing `notice` ChatItem kind (tone "dim" | "error") rather than
 * inventing a new render surface: a passing verify / clean summary is dim with
 * a ✓ marker, a failing verify / non-passing summary is an error line with ✗.
 */
import { clipLine, formatCostUsd, lastNonEmptyLine, loopOutcome } from "@seekforge/shared/format";
import type { LoopEvent, LoopResult, LoopStatus } from "@seekforge/core";

/** A single transcript line: the reducer stamps its id + appends it. */
export type LoopNotice = { text: string; tone: "dim" | "error" };

/** Foreground Loops stream all progress; detached Loops write back only their terminal summary. */
export function shouldRenderLoopEvent(event: LoopEvent, ownsRun: boolean, detached: boolean): boolean {
  return ownsRun || (detached && event.type === "loop.done");
}

/** Max characters kept from a verify-output tail line (compact progress). */
const TAIL_MAX = 200;

/** Last non-empty line of command output, trimmed and clipped — a compact tail. */
export function loopOutputTail(output: string, max = TAIL_MAX): string {
  return clipLine(lastNonEmptyLine(output), max);
}

/**
 * Notice tone for a finished loop. The pass/cancelled/fail classification is
 * shared across surfaces (loopOutcome); the TUI has no warn notice tone, so
 * cancelled folds into dim.
 */
export function loopStatusTone(status: LoopStatus): "dim" | "error" {
  return loopOutcome(status) === "fail" ? "error" : "dim";
}

/**
 * One loop event → the transcript line(s) it produces. `verify` may yield two
 * lines (the pass/fail head plus an output tail); `loop.done` yields the summary
 * block; every other event is a single line.
 */
export function formatLoopEvent(event: LoopEvent): LoopNotice[] {
  switch (event.type) {
    case "iteration.start":
      return [{ text: `⟳ loop · iteration ${event.iteration}`, tone: "dim" }];
    case "run.completed":
      return [
        {
          text: `  loop · iteration ${event.iteration} run complete · ${formatCostUsd(event.costUsd)}${
            event.iterationTokens !== undefined
              ? ` · +${event.iterationTokens} tokens · ${event.durationMs ?? 0}ms · ${event.changedPaths?.length ?? 0} paths`
              : ""
          }`,
          tone: "dim",
        },
      ];
    case "verify.output": {
      const text = clipLine(event.chunk.replace(/\s+$/, "").split("\n").at(-1) ?? "", 240);
      return text ? [{ text: `  ${event.stream === "stderr" ? "!" : "·"} ${text}`, tone: "dim" }] : [];
    }
    case "verify": {
      const head: LoopNotice = event.passed
        ? { text: `  ✓ loop · iteration ${event.iteration} verify passed`, tone: "dim" }
        : {
            text: `  ✗ loop · iteration ${event.iteration} verify failed (exit ${event.code})`,
            tone: "error",
          };
      const tail = loopOutputTail(event.output);
      return tail ? [head, { text: `    ${tail}`, tone: "dim" }] : [head];
    }
    case "verify.stage.completed": {
      const result = event.result;
      return [
        {
          text: `  ${result.code === 0 ? "✓" : "✗"} loop · verifier ${result.id} · ${result.durationMs}ms${
            result.flaky ? " · flaky" : ""
          }`,
          tone: result.code === 0 ? "dim" : "error",
        },
      ];
    }
    case "verify.flaky":
      // A stage that only went green on a retry must not read like a clean pass.
      return [
        {
          text: `  ! loop · verifier ${event.stageId} passed after ${event.attempts} attempts (flaky)`,
          tone: "error",
        },
      ];
    case "verify.impact": {
      // Only worth a line when the pass is partial: every stage having run is
      // what the plain verify line already implies.
      const counts = { run: 0, reuse: 0, skip: 0, blocked: 0 };
      for (const decision of event.decisions) counts[decision.action]++;
      if (counts.reuse === 0 && counts.skip === 0 && counts.blocked === 0) return [];
      return [
        {
          text: `  loop · verification impact · ${counts.run} run, ${counts.reuse} reused, ${counts.skip} skipped, ${counts.blocked} blocked${
            event.fullFallback ? " · full" : ""
          }`,
          tone: "dim",
        },
      ];
    }
    case "loop.paused":
      // Confirms the boundary the /loop-pause notice only promised.
      return [{ text: `  ⏸ loop paused at the iteration ${event.iteration} boundary (/loop-continue)`, tone: "dim" }];
    case "loop.resumed":
      return [{ text: `  ▶ loop resumed at iteration ${event.iteration}`, tone: "dim" }];
    case "loop.steered":
      return [
        {
          text: `  ➤ loop applied ${event.count} guidance message${event.count === 1 ? "" : "s"} at iteration ${event.iteration}`,
          tone: "dim",
        },
      ];
    case "loop.recovery":
      return [
        {
          text: `  ↻ loop · recovery ${event.attempt} after ${event.reason}${
            event.strategy ? ` · ${event.category ?? "unknown"}/${event.strategy}` : ""
          }`,
          tone: "dim",
        },
      ];
    case "loop.rollback":
      // Rollback rewrites the user's files. Never let it pass silently — the
      // re-verify that follows would otherwise look like a duplicate verify.
      return [
        {
          text: `  ↩ loop · iteration ${event.iteration} rolled back — its edits were undone (restored ${event.restored.length}, deleted ${event.deleted.length}); re-verifying`,
          tone: "error",
        },
      ];
    case "loop.model.routed":
      return [
        {
          text: `  loop · ${event.category} → ${event.model} · streak ${event.consecutiveFailures}${event.reason === "escalated_category" ? " · escalated" : ""}`,
          tone: "dim",
        },
      ];
    case "requirements.started":
      return [
        {
          text: `  loop · ${event.phase === "analysis" ? "analyzing requirements" : "reviewing acceptance"}`,
          tone: "dim",
        },
      ];
    case "requirements.completed":
      return [
        {
          text: `  loop · ${event.spec.requirements.length} requirements · ${event.spec.acceptanceCriteria.length} acceptance criteria${event.approvalRequired ? " · approval required" : ""}`,
          tone: "dim",
        },
      ];
    case "requirements.reviewed":
      return [
        {
          text: event.review.complete
            ? "  ✓ loop · acceptance review passed"
            : `  ✗ loop · acceptance incomplete: ${event.review.gaps.join("; ") || "evidence missing"}`,
          tone: event.review.complete ? "dim" : "error",
        },
      ];
    case "loop.warning":
      return [
        {
          text: `  ! loop ${event.warning === "persistence" ? "persistence" : event.warning === "requirements" ? "requirement" : "observer"} warning: ${event.message}`,
          tone: "error",
        },
      ];
    case "loop.done":
      return formatLoopSummary(event.result);
    default:
      // Deliberately silent, because each would add a line per iteration that
      // no user decision depends on: `verify.stage.started` (the completion
      // line carries the outcome, and verify.output already streams progress),
      // `loop.snapshot` (per-iteration bookkeeping), `loop.memory.updated`
      // (internal working memory). Also an exhaustiveness guard: a future
      // LoopEvent variant yields no lines rather than `undefined` (the caller
      // iterates the result).
      return [];
  }
}

/** Final summary block: status, iterations + total cost, and a resume hint. */
export function formatLoopSummary(result: LoopResult): LoopNotice[] {
  const tone = loopStatusTone(result.status);
  const lines: LoopNotice[] = [
    { text: `⟳ loop done — ${result.status}`, tone },
    {
      text: `  iterations: ${result.iterations} · cost: ${formatCostUsd(result.costUsd)}`,
      tone: "dim",
    },
  ];
  if (result.loopId) {
    const resume =
      result.status === "requirements_pending"
        ? `/loop-resume --approve-requirements ${result.loopId}`
        : `/loop-resume ${result.loopId}`;
    lines.push({ text: `  loop: ${result.loopId} (${resume})`, tone: "dim" });
  }
  if (result.sessionId) {
    lines.push({
      text: `  session: ${result.sessionId} (/resume ${result.sessionId} to continue)`,
      tone: "dim",
    });
  }
  return lines;
}
