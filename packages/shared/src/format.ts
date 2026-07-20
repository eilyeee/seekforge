/**
 * Cross-surface pure formatting helpers. The CLI, TUI, and desktop each render
 * loop/usage progress in their own visual language, but the underlying string
 * math — cost formatting, output tails, "did the loop succeed" — must not
 * drift between them.
 */
import type { LoopStatus } from "./index.js";

/** Cost formatted as USD with 4 decimals (matches the chat usage footer style). */
export function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}

/** Last non-empty line of command output, right-trimmed — a compact tail. */
export function lastNonEmptyLine(output: string): string {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trimEnd();
    if (line.trim() !== "") return line;
  }
  return "";
}

/**
 * Truncate a single line to `max` chars with an ellipsis. Backs off one code
 * unit when the cut lands mid surrogate pair, so the ellipsis is never
 * appended to a lone high surrogate (which renders as �).
 */
export function clipLine(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/**
 * Semantic outcome of a finished loop: only a clean pass is a success, a user
 * cancel is neutral, requirements_pending is a deliberate pause awaiting
 * approval (not a failure), and every other terminal status (exhausted /
 * no_progress / budget / verify_error) failed to reach green. Frontends map
 * these outcomes onto their own palettes; the classification itself lives here
 * so it cannot drift between surfaces.
 */
export type LoopOutcome = "pass" | "cancelled" | "pending" | "fail";

export function loopOutcome(status: LoopStatus): LoopOutcome {
  if (status === "passed") return "pass";
  if (status === "cancelled") return "cancelled";
  if (status === "requirements_pending") return "pending";
  return "fail";
}
