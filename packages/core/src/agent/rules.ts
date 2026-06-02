/**
 * Rules-file hierarchy: layered AGENTS.md sources merged into one
 * "project rules" block for the system prompt.
 *
 *   1. ~/.seekforge/AGENTS.md   — user-global, applies to all projects
 *   2. <workspace>/AGENTS.md    — project rules (committed)
 *   3. <workspace>/AGENTS.local.md — personal overrides (gitignore it)
 *   4. <workspace>/<subdir>/AGENTS.md — path-scoped: included ONLY when the
 *      task references a path under that subdir (Claude's nested-CLAUDE.md
 *      pattern, but gated so always-injected rules don't bloat the prompt).
 *
 * Missing or empty files are skipped. Subdir rules are ADDITIVE — global →
 * project → local behavior is unchanged.
 */

import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { taskPathTokens } from "../memory/index.js";

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

// --- Subdir AGENTS.md scan (bounded) ----------------------------------------

/** Directory names never descended into during the subdir scan. */
const SUBDIR_SCAN_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  ".seekforge",
]);
/** Max directory depth (below the workspace root) the scan descends. */
const SUBDIR_SCAN_MAX_DEPTH = 4;
/** Max number of subdir AGENTS.md files collected (hard stop). */
const SUBDIR_SCAN_MAX_FILES = 25;

/** A subdir AGENTS.md plus the workspace-relative dir it was found in. */
type SubdirRule = { relDir: string; content: string };

/**
 * Discovers `AGENTS.md` files in SUBDIRECTORIES of `workspace` (the root's own
 * AGENTS.md is handled by collectRuleFiles, not here). Bounded by depth, file
 * count, and an exclude list; tolerates any fs error (best-effort).
 */
function scanSubdirRules(workspace: string): SubdirRule[] {
  const results: SubdirRule[] = [];
  const walk = (dir: string, depth: number): void => {
    if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
    if (depth > SUBDIR_SCAN_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission/IO error: skip this branch silently
    }
    for (const entry of entries) {
      if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
      if (!entry.isDirectory()) continue;
      if (SUBDIR_SCAN_EXCLUDE.has(entry.name)) continue;
      const childDir = join(dir, entry.name);
      const content = readIfPresent(join(childDir, "AGENTS.md"));
      if (content !== undefined && content.trim().length > 0) {
        results.push({ relDir: relative(workspace, childDir), content });
        if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
      }
      walk(childDir, depth + 1);
    }
  };
  try {
    walk(workspace, 1);
  } catch {
    // Best-effort: subdir rules are non-essential; never throw out of discovery.
  }
  return results;
}

/**
 * True when any task path token falls under `relDir`. A token like
 * "packages/api/src/x.ts" matches relDir "packages/api"; the relDir is
 * normalized to forward slashes so matching works on any OS.
 */
function taskReferencesSubdir(relDir: string, pathTokens: string[]): boolean {
  const norm = relDir.split(sep).join("/").toLowerCase();
  if (norm.length === 0) return false;
  const prefix = `${norm}/`;
  return pathTokens.some((t) => t === norm || t.startsWith(prefix));
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
 *
 * When `task` is given, a subdirectory's AGENTS.md is appended ONLY if the task
 * references a path under that subdir (path-scoped; keeps the always-injected
 * rules from bloating the prompt). The global → project → local layers are
 * unchanged; subdir rules are additive and labeled with their dir.
 */
export function collectProjectRules(
  workspace: string,
  homeOverride?: string,
  task?: string,
): string | undefined {
  const blocks = collectRuleFiles(workspace, homeOverride).map(
    (f) => `<!-- from: ${f.origin} -->\n${f.content.trim()}`,
  );

  if (task && task.trim().length > 0) {
    let pathTokens: string[] = [];
    try {
      pathTokens = taskPathTokens(task).map((t) => t.toLowerCase());
    } catch {
      pathTokens = [];
    }
    if (pathTokens.length > 0) {
      for (const sub of scanSubdirRules(workspace)) {
        if (taskReferencesSubdir(sub.relDir, pathTokens)) {
          const rel = sub.relDir.split(sep).join("/");
          blocks.push(`<!-- from: ${rel}/AGENTS.md -->\n${sub.content.trim()}`);
        }
      }
    }
  }

  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}
