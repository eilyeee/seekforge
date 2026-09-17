/**
 * How one permission rule's `tool` and `match` are compared with a classified
 * call. permissions.ts decides what a match means; this file decides whether
 * there is one.
 *
 * The asymmetry that runs through every function: an `allow` rule must never
 * match more than it says (it authorizes), while `deny` and `ask` rules may
 * match more (over-matching them fails closed).
 */
import * as path from "node:path";
import type { PermissionRule } from "@seekforge/shared";
import { hostWithinDomain } from "./network-policy.js";
import { hasShellControlSyntax, shellInvocations } from "./run-command.js";

type Action = PermissionRule["action"];

/** Tools whose `command` is a shell command line, matched on token boundaries. */
export const SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set(["run_command", "run_tests", "task_kill"]);

/** The subset that executes its command, where a compound line never auto-runs. */
export const SHELL_EXECUTING_TOOLS: ReadonlySet<string> = new Set(["run_command", "run_tests"]);

/** Collapse runs of whitespace so a rule can't be evaded with extra spaces. */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `tool` is an exact name or a `*` glob over names (`mcp__github__*`, `browser_*`, `*`). */
export function toolPatternMatches(pattern: string, toolName: string): boolean {
  if (!pattern.includes("*")) return pattern === toolName;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

/**
 * Prefix match that only counts on a separator boundary: the rule must either
 * already end at a separator (e.g. `docs/`) or the subject must have a
 * separator immediately after the matched prefix. This preserves documented
 * prefix rules while stopping `npm run build` from auto-approving
 * `npm run build-all`, or `src/foo` from granting `src/foobar.ts`.
 */
export function boundaryPrefix(subject: string, match: string, seps: readonly string[]): boolean {
  if (subject === match) return true;
  if (match.length === 0) return true;
  if (!subject.startsWith(match)) return false;
  if (seps.includes(match[match.length - 1]!)) return true;
  return seps.includes(subject[match.length] ?? "");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `*` matches any run of characters. A trailing ` *` also matches nothing, so
 * `git push *` covers a bare `git push`. `anchored` pins the end as well as the
 * start.
 */
function wildcardRegExp(match: string, anchored: boolean): RegExp {
  const trailing = match.endsWith(" *");
  const body = trailing ? match.slice(0, -2) : match;
  const source = body.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}${trailing ? "(?: .*)?" : ""}${anchored ? "$" : ""}`, "s");
}

/**
 * The simple commands a shell line would run, each in the forms a deny rule
 * should recognize: as written, without leading `NAME=value` assignments, and
 * with a path-qualified program reduced to its name.
 */
function invocationSubjects(command: string): string[] {
  const subjects = new Set<string>();
  for (const words of shellInvocations(command)) {
    let start = 0;
    while (start < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start++;
    const rest = words.slice(start);
    subjects.add(normalizeWhitespace(words.join(" ")));
    subjects.add(normalizeWhitespace(rest.join(" ")));
    const program = rest[0] ?? "";
    if (program.includes("/")) {
      subjects.add(normalizeWhitespace([path.posix.basename(program), ...rest.slice(1)].join(" ")));
    }
  }
  return [...subjects].filter((subject) => subject !== "");
}

function shellCommandMatches(action: Action, rawMatch: string, command: string): boolean {
  const subject = normalizeWhitespace(command);
  const match = normalizeWhitespace(rawMatch);
  if (action === "allow") {
    if (!match.includes("*")) return boundaryPrefix(subject, match, [" "]);
    // An allow rule has to name the program it allows: a wildcard in the first
    // word would make "* --version" an approval of every command.
    if ((match.split(" ")[0] ?? "").includes("*")) return false;
    // Anchored at both ends, and never across a control operator — a compound
    // line is not "npm run <something>" even when its text starts that way.
    return !hasShellControlSyntax(command) && wildcardRegExp(match, true).test(subject);
  }
  const test = match.includes("*")
    ? (candidate: string) => wildcardRegExp(match, false).test(candidate)
    : (candidate: string) => candidate.startsWith(match);
  return test(subject) || invocationSubjects(command).some(test);
}

// ---------------------------------------------------------------------------
// URLs (web_fetch / browser_navigate classify as `GET <url>`)
// ---------------------------------------------------------------------------

const GET_PREFIX = "GET ";

function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Structural form of a `GET <url>` prefix rule: same scheme, same host and
 * port, and a path that continues the rule's path at a `/`. A string prefix
 * let `GET https://docs.example.com` approve `https://docs.example.com.evil.net`
 * and `https://docs.example.com@evil.net`.
 */
function urlPrefixMatches(rule: URL, subject: URL): boolean {
  if (rule.protocol !== subject.protocol || rule.host !== subject.host) return false;
  if (rule.search !== "" || rule.hash !== "") return subject.href.startsWith(rule.href);
  return boundaryPrefix(subject.pathname, rule.pathname, ["/"]);
}

function commandUrl(command: string): URL | undefined | null {
  if (!command.startsWith(GET_PREFIX)) return null;
  return parseHttpUrl(command.slice(GET_PREFIX.length));
}

function urlCommandMatches(action: Action, match: string, command: string): boolean | undefined {
  const failClosed = action !== "allow";
  if (match.startsWith("domain:")) {
    const url = commandUrl(command);
    if (url === null) return false;
    if (url === undefined) return failClosed;
    return hostWithinDomain(url.hostname, match.slice("domain:".length));
  }
  if (!match.startsWith(GET_PREFIX)) return undefined;
  const url = commandUrl(command);
  if (url === null) return undefined;
  const raw = normalizeWhitespace(command).startsWith(normalizeWhitespace(match));
  // A rule that names no host (`GET https://`) keeps its plain prefix meaning.
  const ruleUrl = parseHttpUrl(match.slice(GET_PREFIX.length));
  if (ruleUrl === undefined || ruleUrl.hostname === "") return raw;
  if (url === undefined) return failClosed;
  const structural = urlPrefixMatches(ruleUrl, url);
  return action === "allow" ? structural : structural || raw;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The forms a path is compared in: `lexical` is the normalized path, relative
 * to the workspace when it lies inside it; `physical` is where it really
 * resolves (symlinks followed), when that could be determined.
 */
export type PathSubjects = { lexical: string; physical?: string };

function isGlob(match: string): boolean {
  return /[*?]/.test(match);
}

/**
 * Rule globs know `**` (any depth, including none), `*` and `?` (within one
 * segment) and nothing else. The glob tool's compiler also reads `[..]` and
 * `{..}`, which in a permission rule would misread real directory names such
 * as Next.js's `app/[id]` — and a deny rule that silently stops matching fails
 * open.
 */
export function compileRuleGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      let end = i + 2;
      while (pattern[end] === "*") end++;
      const atSegmentStart = i === 0 || pattern[i - 1] === "/";
      if (atSegmentStart && pattern[end] === "/") {
        source += "(?:.*/)?";
        i = end;
      } else {
        source += ".*";
        i = end - 1;
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`, "s");
}

const toPosix = (value: string): string => value.split(path.sep).join("/");

/** Relative to `workspace` when inside it, else absolute; lexical only. */
export function workspaceRelative(workspace: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (!path.isAbsolute(trimmed)) return path.normalize(trimmed);
  const absolute = path.resolve(trimmed);
  const rel = path.relative(workspace, absolute);
  if (rel === "") return ".";
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? absolute : rel;
}

function pathMatches(action: Action, match: string, subject: string): boolean {
  if (isGlob(match)) {
    const glob = compileRuleGlob(match);
    const candidate = toPosix(subject);
    // A deny on `secrets/**` must also stop a tool pointed at `secrets` itself.
    return glob.test(candidate) || (action !== "allow" && glob.test(`${candidate}/`));
  }
  if (action === "allow") return boundaryPrefix(subject, match, ["/", path.sep]);
  return subject.startsWith(match);
}

/** workspaceRelative against the first of the workspace's forms that contains the path. */
export function relativeToAny(rawMatch: string, workspaces: readonly string[]): string {
  let fallback = "";
  for (const workspace of workspaces) {
    const converted = workspaceRelative(workspace, rawMatch);
    if (!path.isAbsolute(converted)) return converted;
    fallback = converted;
  }
  return fallback;
}

function pathRuleMatches(
  action: Action,
  rawMatch: string,
  subjects: PathSubjects,
  workspaces: readonly string[],
): boolean {
  // Permission rules must see the same lexical identity as the filesystem.
  // Otherwise an allow for `src` also grants `src/../outside.ts`, while a deny
  // for `secrets` misses `src/../secrets/key.txt`, `/abs/ws/secrets/key.txt`,
  // or a symlink into `secrets`.
  const match = isGlob(rawMatch) ? rawMatch.trim().replace(/^\.\//, "") : relativeToAny(rawMatch, workspaces);
  const forms = [subjects.lexical, ...(subjects.physical !== undefined ? [subjects.physical] : [])];
  return action === "allow"
    ? forms.every((form) => pathMatches(action, match, form))
    : forms.some((form) => pathMatches(action, match, form));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type RuleSubject = {
  toolName: string;
  command?: string;
  /** Compared when the call has no command; see PathSubjects. */
  path: PathSubjects;
  /** The workspace as configured and as physically resolved (either may name it). */
  workspaces: readonly string[];
};

export function ruleMatches(rule: PermissionRule, subject: RuleSubject): boolean {
  if (!toolPatternMatches(rule.tool, subject.toolName)) return false;
  if (rule.match === undefined) return true;
  if (subject.command !== undefined) {
    if (SHELL_COMMAND_TOOLS.has(subject.toolName)) {
      return shellCommandMatches(rule.action, rule.match, subject.command);
    }
    const url = urlCommandMatches(rule.action, rule.match, subject.command);
    if (url !== undefined) return url;
    // Other command-bearing tools (web_search's `SEARCH <query>`, MCP's
    // `mcp:<server>/<tool>`) keep the documented plain prefix test.
    return normalizeWhitespace(subject.command).startsWith(normalizeWhitespace(rule.match));
  }
  if (rule.match.startsWith("domain:")) return false;
  return pathRuleMatches(rule.action, rule.match, subject.path, subject.workspaces);
}
