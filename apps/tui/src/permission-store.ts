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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireSessionLease, acquireWorkspaceSessionGuard } from "@seekforge/core";
import type { PermissionRule } from "@seekforge/shared";
import { GLOBAL_CONFIG_LOCK_ID } from "@seekforge/shared/config-layers";
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
  // Read-modify-write of a file several processes edit — `seekforge config set
  // --global`, a Desktop approval reaching the server, this. Without the lease
  // two of them landing together silently drop one edit: the file stays valid
  // and the rule the user just approved is simply not in it.
  //
  // It does not wait. A collision means another SeekForge process is writing
  // this instant, which is rare; the approval degrades to session scope with a
  // notice naming the reason, which is a better answer than a stall.
  const lease = acquireSessionLease(realpathSync(home), GLOBAL_CONFIG_LOCK_ID);
  try {
    return writeRule(rule, home);
  } finally {
    lease.release();
  }
}

function writeRule(rule: PermissionRule, home: string): string {
  return editRules(userConfigPath(home), (existing) =>
    // Appended, not prepended: a deny the user already wrote keeps winning
    // (deny is scanned first regardless, but order is also what a reader sees).
    existing.some((candidate) => sameRule(candidate, rule)) ? existing : [...existing, rule],
  );
}

function readConfigDoc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: config root must be an object`);
  }
  return parsed as Record<string, unknown>;
}

/** Read-modify-write of one config file's `permissionRules`; other keys are untouched. */
function editRules(path: string, edit: (existing: PermissionRule[]) => PermissionRule[]): string {
  const doc = readConfigDoc(path);
  const existing = Array.isArray(doc.permissionRules) ? (doc.permissionRules as PermissionRule[]) : [];
  const next = edit(existing);
  if (next.length > 0) doc.permissionRules = next;
  else delete doc.permissionRules;
  // The same atomic, symlink-refusing writer every other state file uses: the
  // config is the last file that should be left half-written or followed
  // through a link someone dropped in ~/.seekforge.
  writeStateFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

/** The two files `/permissions` edits. */
export type RuleScope = "user" | "project";

export function projectConfigPath(projectPath: string): string {
  return join(projectPath, ".seekforge", "config.json");
}

/** A rule shaped like the config merge accepts; anything else is not a rule. */
export function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    (rule.action === "allow" || rule.action === "deny" || rule.action === "ask") &&
    typeof rule.tool === "string" &&
    (rule.match === undefined || typeof rule.match === "string")
  );
}

/** The rules one config file declares, or the reason it could not be read. */
export function readRulesFile(path: string): { rules: PermissionRule[]; error?: string } {
  try {
    const doc = readConfigDoc(path);
    const rules = Array.isArray(doc.permissionRules) ? doc.permissionRules.filter(isPermissionRule) : [];
    return { rules };
  } catch (error) {
    return { rules: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** A repository config cannot grant: the loader strips its allow rules. */
export class ProjectAllowRuleError extends Error {
  constructor() {
    super("the project config may only tighten — allow rules there are ignored on load; save it to your user config");
    this.name = "ProjectAllowRuleError";
  }
}

export type RuleLocation = { projectPath: string; home?: string };

/**
 * Serializes one edit of a scope's file: the user file under the cross-process
 * global-config lease, the project file under the workspace session guard, so
 * a project policy change never lands in the middle of an agent run
 * (boundary checklist #119).
 */
function withScopeLock<T>(scope: RuleScope, where: RuleLocation, fn: () => T): T {
  const lease =
    scope === "user"
      ? acquireSessionLease(realpathSync(where.home ?? homedir()), GLOBAL_CONFIG_LOCK_ID)
      : acquireWorkspaceSessionGuard(where.projectPath);
  try {
    return fn();
  } finally {
    lease.release();
  }
}

function scopePath(scope: RuleScope, where: RuleLocation): string {
  return scope === "user" ? userConfigPath(where.home) : projectConfigPath(where.projectPath);
}

/** Adds `rule` to the scope's file (idempotent) and returns the file it wrote. */
export function addPermissionRule(scope: RuleScope, rule: PermissionRule, where: RuleLocation): string {
  if (scope === "project" && rule.action === "allow") throw new ProjectAllowRuleError();
  const clean: PermissionRule = {
    action: rule.action,
    tool: rule.tool,
    ...(rule.match !== undefined && rule.match !== "" ? { match: rule.match } : {}),
  };
  return withScopeLock(scope, where, () =>
    editRules(scopePath(scope, where), (existing) =>
      existing.some((candidate) => sameRule(candidate, clean)) ? existing : [...existing, clean],
    ),
  );
}

/**
 * Sets `trusted` on one MCP server entry of the USER config — the flag that
 * lets automatic discovery connect it. Only an entry the user's own file
 * defines can be changed: a repository's trust flag is stripped on load, and a
 * server that came from --settings or --mcp-config lives in that file.
 */
export function setUserMcpServerTrusted(
  name: string,
  trusted: boolean,
  opts: { home?: string; expected?: object } = {},
): string {
  const home = opts.home ?? homedir();
  const path = userConfigPath(home);
  const lease = acquireSessionLease(realpathSync(home), GLOBAL_CONFIG_LOCK_ID);
  try {
    const doc = readConfigDoc(path);
    const servers = doc.mcpServers;
    const entry =
      typeof servers === "object" && servers !== null && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)[name]
        : undefined;
    // The running entry may come from a --settings or --mcp-config file that
    // shadows a same-named one here; flipping this one would change nothing
    // that is running and say otherwise.
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      (opts.expected !== undefined && canonicalEntry(entry) !== canonicalEntry(opts.expected))
    ) {
      throw new Error(`"${name}" is not defined in ${path} — change it in the file that defines it`);
    }
    (entry as Record<string, unknown>).trusted = trusted;
    writeStateFile(path, `${JSON.stringify(doc, null, 2)}\n`);
    return path;
  } finally {
    lease.release();
  }
}

/** An MCP entry's identity for comparison: every field but the trust flag, keys sorted. */
function canonicalEntry(entry: object): string {
  const { trusted: _ignored, ...rest } = entry as Record<string, unknown>;
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]),
    );
  };
  return JSON.stringify(sorted(rest));
}

/** Removes every copy of `rule` from the scope's file and returns the file it wrote. */
export function removePermissionRule(scope: RuleScope, rule: PermissionRule, where: RuleLocation): string {
  return withScopeLock(scope, where, () =>
    editRules(scopePath(scope, where), (existing) =>
      existing.filter((candidate) => !isPermissionRule(candidate) || !sameRule(candidate, rule)),
    ),
  );
}

/** How the rule reads in a prompt or notice — the raw match, never a paraphrase. */
export function describeRule(rule: PermissionRule): string {
  return rule.match === undefined ? `${rule.action} ${rule.tool}` : `${rule.action} ${rule.tool}: ${rule.match}`;
}
