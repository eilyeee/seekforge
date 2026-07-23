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
//   --allowedTools a,b      → an exact AgentCoreDeps.allowedTools gate. This is
//                             evaluated against every call, including MCP,
//                             future built-ins, and synthetic dispatch tools.

import type { PermissionRule } from "@seekforge/shared";

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
}): PermissionRule[] | undefined {
  const disallowed = parseToolList(opts.disallowedTools);
  const allowed = parseToolList(opts.allowedTools);
  if (allowed.length === 0 && disallowed.length === 0) return undefined;
  const synthesized: PermissionRule[] = [];

  // Explicit disallow: a deny rule per named tool.
  for (const tool of disallowed) {
    synthesized.push({ action: "deny", tool });
  }

  return [...synthesized, ...(opts.base ?? [])];
}
