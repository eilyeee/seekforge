/**
 * Rules-file hierarchy: layered AGENTS.md sources merged into one
 * "project rules" block for the system prompt.
 *
 *   1. ~/.seekforge/AGENTS.md   — user-global, applies to all projects
 *   2. <workspace>/AGENTS.md    — project rules (committed)
 *   3. <workspace>/AGENTS.local.md — personal overrides (gitignore it)
 *
 * Missing or empty files are skipped.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuleFile = {
  /** Display origin used in the section header (e.g. "~/.seekforge/AGENTS.md"). */
  origin: string;
  content: string;
};

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Loads each rules layer that exists and is non-empty, in precedence order. */
export function collectRuleFiles(workspace: string, homeOverride?: string): RuleFile[] {
  const home = homeOverride ?? homedir();
  const layers: Array<{ origin: string; path: string }> = [
    { origin: "~/.seekforge/AGENTS.md", path: join(home, ".seekforge", "AGENTS.md") },
    { origin: "AGENTS.md", path: join(workspace, "AGENTS.md") },
    { origin: "AGENTS.local.md", path: join(workspace, "AGENTS.local.md") },
  ];
  const out: RuleFile[] = [];
  for (const layer of layers) {
    const content = readIfPresent(layer.path);
    if (content !== undefined && content.trim().length > 0) {
      out.push({ origin: layer.origin, content });
    }
  }
  return out;
}

/**
 * Concatenates all present rules layers, each prefixed by an origin header
 * comment. Returns undefined when no layer contributes anything.
 */
export function collectProjectRules(workspace: string, homeOverride?: string): string | undefined {
  const files = collectRuleFiles(workspace, homeOverride);
  if (files.length === 0) return undefined;
  return files.map((f) => `<!-- from: ${f.origin} -->\n${f.content.trim()}`).join("\n\n");
}
