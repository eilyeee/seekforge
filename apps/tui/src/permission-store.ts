/**
 * Persisting an approval.
 *
 * "Allow for this session" dies with the run, so the tenth `pnpm test` of the
 * week is the tenth prompt. The alternative until now was hand-editing
 * `permissionRules` in a JSON file, which is why almost nobody had any: the
 * feature existed and was unreachable from where the question is actually
 * asked.
 *
 * Two properties matter more than the convenience:
 *
 * **It writes to the user's own config, never the project's.** A rule in
 * `.seekforge/config.json` inside a repository is stripped on load —
 * sanitizeProjectConfig keeps only deny rules, because a repository cannot be
 * allowed to grant itself permissions. Writing there would produce a rule that
 * saves, displays, and never fires. So this writes `~/.seekforge/config.json`,
 * and the prompt says which file it touched.
 *
 * **It writes exactly the rule core proposed.** The rule shown in the prompt
 * is `request.rememberRule`, and that same object is what lands on disk. No
 * widening on the way through, no reconstruction from a description a model
 * wrote.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@seekforge/shared";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { writeStateFile } from "./state-file.js";

/** The user-owned config layer — the only one where an allow rule survives. */
export function userConfigPath(home: string = homedir()): string {
  return join(home, ".seekforge", "config.json");
}

/** Same identity test the merge uses: a rule is its action + tool + match. */
export function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.action === b.action && a.tool === b.tool && (a.match ?? "") === (b.match ?? "");
}

/**
 * Add one allow rule to the user config, and return the path it was written
 * to. Idempotent: approving the same command twice does not grow the file.
 *
 * Throws when the config exists but does not parse — the caller reports it and
 * the run continues on the session grant. Writing a fresh `{}` over a file we
 * failed to read would drop every setting in it, which is a far worse outcome
 * than one un-persisted approval.
 */
export function persistPermissionRule(rule: PermissionRule, home: string = homedir()): string {
  const path = userConfigPath(home);
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path}: config root must be an object`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const existing = Array.isArray(doc.permissionRules) ? (doc.permissionRules as PermissionRule[]) : [];
  if (!existing.some((candidate) => sameRule(candidate, rule))) {
    // Appended, not prepended: a deny the user already wrote keeps winning
    // (deny is scanned first regardless, but order is also what a reader sees).
    doc.permissionRules = [...existing, rule];
  }
  // The same atomic, symlink-refusing writer every other state file uses: the
  // config is the last file that should be left half-written or followed
  // through a link someone dropped in ~/.seekforge.
  writeStateFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

/** How the rule reads in a prompt or notice — the raw match, never a paraphrase. */
export function describeRule(rule: PermissionRule): string {
  return rule.match === undefined ? `${rule.action} ${rule.tool}` : `${rule.action} ${rule.tool}: ${rule.match}`;
}
