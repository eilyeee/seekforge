// `--allowedTools` / `--disallowedTools` → synthesized permissionRules.
//
// Core enforces a list of PermissionRule (allow/deny by tool name, "*" = any).
// Evaluation (see core tools/permissions.ts):
//   * deny rules are scanned FIRST; the first matching deny blocks at EVERY
//     level (including readonly), never prompts, never runs;
//   * an allow rule never rescues a "dangerous" call and never overrides
//     ask-mode blocking; it only skips the confirmation prompt.
//
// Consequences for this mapping:
//   --disallowedTools a,b   → one `deny` rule per tool. Straightforward and
//                             exact: those tools are blocked, the rest behave
//                             normally (prompt/auto per approval mode).
//   --allowedTools a,b      → "only these tools." Because a single `deny *`
//                             would also block the listed tools (deny wins over
//                             allow), we instead emit a `deny` rule for every
//                             KNOWN tool that is NOT in the allow-list. The
//                             listed tools then behave normally.
//
// LIMITATION: the allow-list is built against KNOWN_TOOL_NAMES (the built-in
// roster). A tool unknown here (e.g. an MCP-provided tool, or a future built-in)
// is NOT denied by --allowedTools, so it could still run. --disallowedTools has
// no such limit (it denies exactly what you name). For an exhaustive allow-list
// including MCP tools, prefer --disallowedTools.

import type { PermissionRule } from "@seekforge/shared";

/** Built-in tool roster used to synthesize an exhaustive allow-list. */
export const KNOWN_TOOL_NAMES = [
  "apply_patch",
  "ask_user",
  "detect_project",
  "git_commit",
  "git_diff",
  "git_status",
  "image_analyze",
  "list_files",
  "list_scripts",
  "read_file",
  "run_command",
  "search_text",
  "task_kill",
  "task_output",
  "update_plan",
  "web_fetch",
  "web_search",
  "write_file",
] as const;

/** Splits a comma-separated tool list, trimming blanks. `["read_file", ...]`. */
export function parseToolList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => p.split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Builds the synthesized permissionRules for a run from the CLI tool flags.
 * Returns undefined when neither flag is used (so config rules pass through
 * unchanged). When used, the synthesized rules are prepended to the existing
 * base rules so user gating takes precedence (rules are first-match-wins, and
 * deny rules are scanned before allow rules regardless of order).
 */
export function buildToolGatingRules(opts: {
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  base?: PermissionRule[];
  /** Roster to deny against for an allow-list; defaults to KNOWN_TOOL_NAMES. */
  knownTools?: readonly string[];
}): PermissionRule[] | undefined {
  const allowed = parseToolList(opts.allowedTools);
  const disallowed = parseToolList(opts.disallowedTools);
  if (allowed.length === 0 && disallowed.length === 0) return undefined;

  const known = opts.knownTools ?? KNOWN_TOOL_NAMES;
  const synthesized: PermissionRule[] = [];

  // Explicit disallow: a deny rule per named tool.
  for (const tool of disallowed) {
    synthesized.push({ action: "deny", tool });
  }

  // Allow-list: deny every known tool not in the allow-list. (Listed tools get
  // no rule, so they behave per the normal policy.) Tools already covered by an
  // explicit disallow are skipped to avoid duplicate rules.
  if (allowed.length > 0) {
    const allowSet = new Set(allowed);
    const disallowSet = new Set(disallowed);
    for (const tool of known) {
      if (allowSet.has(tool) || disallowSet.has(tool)) continue;
      synthesized.push({ action: "deny", tool });
    }
  }

  return [...synthesized, ...(opts.base ?? [])];
}
