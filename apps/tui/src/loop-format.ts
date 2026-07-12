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
import type { LoopEvent, LoopResult, LoopStatus } from "@seekforge/core";

/** A single transcript line: the reducer stamps its id + appends it. */
export type LoopNotice = { text: string; tone: "dim" | "error" };

/** Max characters kept from a verify-output tail line (compact progress). */
const TAIL_MAX = 200;

/** Last non-empty line of command output, trimmed and clipped — a compact tail. */
export function loopOutputTail(output: string, max = TAIL_MAX): string {
  const lines = output.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trimEnd();
    if (line.trim() !== "") {
      last = line;
      break;
    }
  }
  if (last.length <= max) return last;
  // Back off one code unit if the cut lands mid surrogate pair, so we never
  // append the ellipsis to a lone high surrogate (which renders as �).
  let cut = max - 1;
  const code = last.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${last.slice(0, cut)}…`;
}

/**
 * Notice tone for a finished loop: a clean pass or a user cancel is calm (dim);
 * every other terminal status (exhausted / no_progress / budget / verify_error)
 * failed to reach green and reads as an error. Mirrors desktop's loopStatusTone
 * (which additionally distinguishes cancelled as "warn"; the TUI has no warn
 * notice tone, so cancelled folds into dim).
 */
export function loopStatusTone(status: LoopStatus): "dim" | "error" {
  return status === "passed" || status === "cancelled" ? "dim" : "error";
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
          text: `  loop · iteration ${event.iteration} run complete · $${event.costUsd.toFixed(4)}`,
          tone: "dim",
        },
      ];
    case "verify.output": {
      const text = event.chunk.replace(/\s+$/, "").split("\n").at(-1)?.slice(0, 240) ?? "";
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
    case "loop.warning":
      return [{ text: `  ! loop persistence warning: ${event.message}`, tone: "error" }];
    case "loop.done":
      return formatLoopSummary(event.result);
    default:
      // Exhaustiveness guard: a future LoopEvent variant yields no lines rather
      // than `undefined` (the caller iterates the result).
      return [];
  }
}

/** Final summary block: status, iterations + total cost, and a resume hint. */
export function formatLoopSummary(result: LoopResult): LoopNotice[] {
  const tone = loopStatusTone(result.status);
  const lines: LoopNotice[] = [
    { text: `⟳ loop done — ${result.status}`, tone },
    {
      text: `  iterations: ${result.iterations} · cost: $${result.costUsd.toFixed(4)}`,
      tone: "dim",
    },
  ];
  if (result.loopId) {
    lines.push({ text: `  loop: ${result.loopId} (/loop-resume ${result.loopId})`, tone: "dim" });
  }
  if (result.sessionId) {
    lines.push({
      text: `  session: ${result.sessionId} (/resume ${result.sessionId} to continue)`,
      tone: "dim",
    });
  }
  return lines;
}
