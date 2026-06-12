// Output styles — Claude-Code-style system-prompt presets.
//
// An output style does not change WHAT the agent does, only HOW it communicates.
// Each non-default style contributes an addendum that the integrator appends to
// the system prompt via the existing `appendSystemPrompt` seam. "default" makes
// no change (returns undefined) so the base prompt is used verbatim.
//
// Beyond the built-ins, a user can define their own style as a Markdown file at
// .seekforge/output-styles/<name>.md (project, then ~/.seekforge); its body
// (frontmatter stripped) is used as the addendum verbatim.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
// These addenda are deliberately forceful and prescriptive: a soft "prefer
// brevity" note gets ignored, so each style states hard rules that visibly
// change the SHAPE of the response. This block overrides any default verbosity
// guidance in the base prompt.
const ADDENDA: Readonly<Record<Exclude<OutputStyle, "default">, string>> = {
  concise: [
    "## Output style: Concise (overrides default verbosity)",
    "",
    "Be maximally terse. Hard rules:",
    "- Lead with the answer on the FIRST line, then stop. No preamble, no restating the question, no closing summary.",
    "- Default to ONE to THREE sentences. Use a one-line answer whenever it is correct and complete.",
    "- No filler (\"Great question\", \"Sure\", \"I'll help…\"). No reasoning narration — give the conclusion, not the path to it.",
    "- Use a bullet list only when the answer is inherently a list; otherwise plain sentences.",
  ].join("\n"),

  explanatory: [
    "## Output style: Explanatory (overrides default verbosity)",
    "",
    "Teach as you answer — the user wants the WHY, not just the what. Hard rules:",
    "- Give the answer, then ALWAYS explain the reasoning behind it: why this and not the alternatives.",
    "- Explicitly call out non-obvious decisions, trade-offs, and insights about how the codebase works.",
    "- When relevant, add a short \"Why this works\" or \"Trade-off\" note. Aim noticeably richer than a bare answer.",
    "- Keep it structured and readable; do not pad with filler, but do not under-explain either.",
  ].join("\n"),

  learning: [
    "## Output style: Learning (overrides default behavior)",
    "",
    "Collaborate and favor learn-by-doing. Hard rules:",
    "- Do most of the task, but deliberately leave 1–3 well-chosen pieces for the user to implement themselves.",
    "- Mark each hand-off with a clearly labeled `TODO(human):` comment that states exactly what to implement and why it's a good thing to learn.",
    "- Briefly explain the surrounding code so the user can complete the TODO unaided.",
    "- Do not silently finish the parts you handed off — leaving them for the user is the point.",
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

/** Strips an optional leading YAML frontmatter block, returning the trimmed body. */
function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  return (m ? (m[1] as string) : md).trim();
}

/**
 * Loads a custom output style from `.seekforge/output-styles/<name>.md`
 * (project first, then `~/.seekforge`). The file body (frontmatter stripped)
 * is the addendum. Returns undefined when no such file exists in any layer.
 */
export function loadCustomOutputStyle(name: string, projectPath: string): string | undefined {
  const dirs = [
    join(projectPath, ".seekforge", "output-styles"),
    join(homedir(), ".seekforge", "output-styles"),
  ];
  for (const dir of dirs) {
    try {
      const body = stripFrontmatter(readFileSync(join(dir, `${name}.md`), "utf8"));
      if (body) return body;
    } catch {
      // not present in this layer — try the next
    }
  }
  return undefined;
}

/**
 * Resolves an output style to its system-prompt addendum: a built-in style uses
 * its preset; otherwise a custom `.seekforge/output-styles/<name>.md` file.
 * Returns undefined for "default" (no change). Throws if neither resolves.
 */
export function resolveOutputStyle(style: string, projectPath: string): string | undefined {
  if (isOutputStyle(style)) return outputStylePrompt(style);
  const custom = loadCustomOutputStyle(style, projectPath);
  if (custom !== undefined) return custom;
  throw new Error(
    `Unknown output style: ${JSON.stringify(style)}. Expected a built-in (${OUTPUT_STYLES.join(", ")}) ` +
      `or a .seekforge/output-styles/${style}.md file.`,
  );
}
