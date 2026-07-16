/**
 * Pure logic for the `/worktree` command: subcommand parsing, free-slug picking,
 * filtering `git worktree list` output to SeekForge-managed checkouts, and
 * resolving a remove target from a listing + a user argument. No fs, no git —
 * the app layer supplies the async predicates and runs the `@seekforge/core`
 * git primitives; this module stays deterministic and unit-tested.
 */

import { worktreeSlug, type GitWorktreeEntry } from "@seekforge/core";

/** Parsed `/worktree` subcommand. `usage` covers bare + unknown subcommands. */
export type WorktreeSub =
  | { kind: "list" }
  | { kind: "new"; name?: string }
  | { kind: "remove"; target?: string }
  | { kind: "usage" };

/** SeekForge worktree branches live under this prefix (`seekforge/<slug>`). */
const BRANCH_PREFIX = "seekforge/";

/**
 * Splits the rest-of-line argument of `/worktree` into a subcommand. `list`,
 * `new [name]` and `remove <slug-or-branch>` are recognized (with `ls`/`add`/`rm`
 * aliases); anything else — including a bare `/worktree` — is `usage`.
 */
export function parseWorktreeCommand(arg: string | undefined): WorktreeSub {
  const trimmed = (arg ?? "").trim();
  if (trimmed === "") return { kind: "usage" };
  const [head, ...rest] = trimmed.split(/\s+/);
  const sub = (head ?? "").toLowerCase();
  const restText = rest.join(" ").trim();
  if (sub === "list" || sub === "ls") return { kind: "list" };
  if (sub === "new" || sub === "add") return { kind: "new", ...(restText ? { name: restText } : {}) };
  if (sub === "remove" || sub === "rm") return { kind: "remove", ...(rest[0] ? { target: rest[0] } : {}) };
  return { kind: "usage" };
}

/** The `<slug>` portion of a `seekforge/<slug>` branch (or "" if not managed). */
export function slugOfBranch(branch: string): string {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : "";
}

/** Keeps only SeekForge-managed worktrees (branch under `seekforge/`). */
export function seekforgeWorktrees(entries: GitWorktreeEntry[]): GitWorktreeEntry[] {
  return entries.filter((e) => e.branch.startsWith(BRANCH_PREFIX));
}

/**
 * Picks a free slug: `worktreeSlug(name)`, then `<slug>-2`, `<slug>-3`, … until
 * `exists` returns false. `exists` is injected (the app wires it to
 * `worktreeBranchExists`) so this is testable without git. Bounded by
 * `maxAttempts` (default 100); exhausting it throws.
 */
export async function pickFreeSlug(
  name: string | undefined,
  exists: (slug: string) => Promise<boolean>,
  opts: { now?: Date; maxAttempts?: number } = {},
): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 100;
  const base = worktreeSlug(name, opts.now);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await exists(slug))) return slug;
  }
  throw new Error(`could not find a free worktree slug for "${base}" after ${maxAttempts} attempts`);
}

/**
 * Resolves `arg` to a SeekForge-managed worktree from a `listGitWorktrees`
 * result. Matches when `arg` equals the slug, the full `seekforge/<slug>`
 * branch, or the branch's last path segment. Returns undefined if no match.
 */
export function resolveWorktreeTarget(entries: GitWorktreeEntry[], arg: string): GitWorktreeEntry | undefined {
  const wanted = arg.trim();
  if (wanted === "") return undefined;
  return seekforgeWorktrees(entries).find((e) => {
    const slug = slugOfBranch(e.branch);
    const segment = e.branch.split("/").pop() ?? "";
    return wanted === slug || wanted === e.branch || wanted === segment;
  });
}
