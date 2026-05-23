// Output styles — Claude-Code-style system-prompt presets.
//
// An output style does not change WHAT the agent does, only HOW it communicates.
// Each non-default style contributes an addendum that the integrator appends to
// the system prompt via the existing `appendSystemPrompt` seam. "default" makes
// no change (returns undefined) so the base prompt is used verbatim.

/** The set of supported output styles. */
export type OutputStyle = "default" | "concise" | "explanatory" | "learning";

/** All styles, in canonical order (default first). */
export const OUTPUT_STYLES: readonly OutputStyle[] = [
  "default",
  "concise",
  "explanatory",
  "learning",
] as const;

/** Type guard: is `s` one of the known output styles? */
export function isOutputStyle(s: string): s is OutputStyle {
  return (OUTPUT_STYLES as readonly string[]).includes(s);
}

// Addendum text per style. "default" is intentionally absent — it yields no
// addendum. Wording is imperative and terse, matching how a coding-agent system
// prompt reads.
const ADDENDA: Readonly<Record<Exclude<OutputStyle, "default">, string>> = {
  concise: [
    "## Output style: Concise",
    "",
    "Minimize prose. Lead with the answer or result, then stop.",
    "Drop preamble, restatements of the request, and closing summaries unless the user asks for them.",
    "Prefer the shortest response that is still correct and complete. When a one-line answer suffices, give one line.",
  ].join("\n"),

  explanatory: [
    "## Output style: Explanatory",
    "",
    "While doing the task, surface your reasoning so the user learns the why, not just the what.",
    "Call out non-obvious decisions, trade-offs you weighed, and insights about the codebase as you work.",
    "Keep explanations brief and woven into the work — short notes alongside the changes, not a separate essay.",
  ].join("\n"),

  learning: [
    "## Output style: Learning",
    "",
    "Work collaboratively and favor learn-by-doing. Do the task, but when a piece is a good learning opportunity, leave it for the user.",
    "Mark such hand-offs with a clearly labeled `TODO(human)` comment and briefly explain what to implement and why.",
    "Ask the user to make some of the changes themselves rather than completing 100% of the work yourself.",
  ].join("\n"),
};

/**
 * The system-prompt addendum for a style.
 * Returns `undefined` for "default" (no change). Throws for an unknown style.
 */
export function outputStylePrompt(style: string): string | undefined {
  if (!isOutputStyle(style)) {
    throw new Error(
      `Unknown output style: ${JSON.stringify(style)}. Expected one of: ${OUTPUT_STYLES.join(", ")}.`,
    );
  }
  if (style === "default") return undefined;
  return ADDENDA[style];
}
