/**
 * `.gitignore` support for the tools that walk the workspace (list_files,
 * search_text, glob) and for nested-rule discovery.
 *
 * Dependency-free and deliberately partial: root and nested `.gitignore`
 * files plus `$GIT_DIR/info/exclude`, with git's pattern grammar — `#`
 * comments, `!` negation, a trailing `/` for directories only, a leading or
 * middle `/` anchoring the pattern to its file's directory, `*` / `?` / `[...]`
 * that never cross `/`, and `**` in its three positional forms. Not read:
 * `core.excludesFile` (it would mean parsing git config) and `.ignore` files.
 *
 * Git's own rule that nothing below an ignored directory can be re-included
 * falls out of the walkers: they never descend into a directory this matcher
 * ignores.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readFileBoundedSync } from "../util/fs.js";

const MAX_IGNORE_FILE_BYTES = 256 * 1024;
const MAX_GITDIR_POINTER_BYTES = 4096;
const MAX_CACHED_IGNORE_FILES = 2048;
const MAX_GIT_ROOT_HOPS = 128;

type IgnoreRule = {
  negated: boolean;
  dirOnly: boolean;
  /** Matched against the base-relative path (the pattern had a `/`), else the basename. */
  anchored: boolean;
  /** Unanchored pattern with no wildcard: a plain name comparison. */
  literal?: string;
  re?: RegExp;
};

type RuleSet = {
  /** Directory the rules are relative to, as a match-root-relative path ("" = the root). */
  base: string;
  rules: readonly IgnoreRule[];
};

/** The rule sets that apply to the entries of one directory, lowest precedence first. */
export type IgnoreFrame = readonly RuleSet[];

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: " \\t\\r\\n\\v\\f",
  xdigit: "0-9a-fA-F",
};

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(ch) ? `\\${ch}` : ch;
}

/** Compile a bracket expression starting at `start` (the `[`); undefined when unterminated. */
function compileClass(pattern: string, start: number): { source: string; end: number } | undefined {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negated = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "]" && !first) {
      // A class never matches "/" under git's pathname matching.
      return { source: `(?!/)[${negated ? "^" : ""}${body}]`, end: i + 1 };
    }
    first = false;
    if (ch === "[" && pattern[i + 1] === ":") {
      const close = pattern.indexOf(":]", i + 2);
      const name = close === -1 ? undefined : pattern.slice(i + 2, close);
      if (name !== undefined && POSIX_CLASSES[name] !== undefined) {
        body += POSIX_CLASSES[name];
        i = close + 2;
        continue;
      }
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      body += escapeRegExpChar(pattern[i + 1] as string);
      i += 2;
      continue;
    }
    // Keep ranges ("a-z") but escape everything else a JS class treats specially.
    body += ch === "-" ? "-" : ch === "^" || ch === "\\" || ch === "]" || ch === "[" ? `\\${ch}` : ch;
    i++;
  }
  return undefined;
}

/** Git wildmatch (pathname mode) → anchored RegExp source. */
function compileWildmatch(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      let j = i;
      while (pattern[j] === "*") j++;
      const segmentStart = i === 0 || pattern[i - 1] === "/";
      const segmentEnd = j === pattern.length || pattern[j] === "/";
      if (j - i >= 2 && segmentStart && segmentEnd) {
        if (j === pattern.length) {
          out += ".*";
          i = j;
        } else {
          // "**/": zero or more whole directories.
          out += "(?:.*/)?";
          i = j + 1;
        }
        continue;
      }
      // Any other run of asterisks is an ordinary "*".
      out += "[^/]*";
      i = j;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const cls = compileClass(pattern, i);
      if (cls) {
        out += cls.source;
        i = cls.end;
        continue;
      }
      out += "\\[";
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeRegExpChar(pattern[i + 1] as string);
      i += 2;
      continue;
    }
    out += escapeRegExpChar(ch);
    i++;
  }
  return `^${out}$`;
}

/** Strip trailing spaces unless the last one is escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function parseRule(rawLine: string): IgnoreRule | undefined {
  let line = trimTrailingSpaces(rawLine.replace(/\r$/, ""));
  if (line === "" || line.startsWith("#")) return undefined;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.replace(/\/+$/, "");
  }
  if (line === "") return undefined;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  if (line === "") return undefined;
  if (!anchored && !/[*?[\\]/.test(line)) {
    return { negated, dirOnly, anchored, literal: line };
  }
  try {
    return { negated, dirOnly, anchored, re: new RegExp(compileWildmatch(line)) };
  } catch {
    return undefined;
  }
}

/** Parse the text of one ignore file. Exported for tests. */
export function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const rule = parseRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

type CachedIgnoreFile = { mtimeMs: number; size: number; ino: number; rules: IgnoreRule[] };

// Keyed by absolute path and revalidated against the file's stat on every use,
// so an edited .gitignore takes effect on the next walk while an unchanged one
// is parsed once per process rather than once per tool call.
const ignoreFileCache = new Map<string, CachedIgnoreFile>();

function loadIgnoreFile(absFile: string): IgnoreRule[] {
  // lstat, not stat: like git (2.32+), a symlinked ignore file is not followed.
  const st = fs.lstatSync(absFile, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    ignoreFileCache.delete(absFile);
    return [];
  }
  const cached = ignoreFileCache.get(absFile);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ino === st.ino) {
    return cached.rules;
  }
  let rules: IgnoreRule[];
  try {
    rules = parseIgnoreRules(readFileBoundedSync(absFile, MAX_IGNORE_FILE_BYTES).toString("utf8"));
  } catch {
    // Oversized or unreadable: treat as absent rather than failing the walk.
    rules = [];
  }
  ignoreFileCache.delete(absFile);
  ignoreFileCache.set(absFile, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, rules });
  if (ignoreFileCache.size > MAX_CACHED_IGNORE_FILES) {
    const oldest = ignoreFileCache.keys().next().value;
    if (oldest !== undefined) ignoreFileCache.delete(oldest);
  }
  return rules;
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

function joinRel(a: string, b: string): string {
  if (a === "") return b;
  if (b === "") return a;
  return `${a}/${b}`;
}

function readSmallText(file: string): string | undefined {
  try {
    return readFileBoundedSync(file, MAX_GITDIR_POINTER_BYTES).toString("utf8").trim();
  } catch {
    return undefined;
  }
}

/** `$GIT_COMMON_DIR/info/exclude` for a `.git` directory or a worktree's `.git` file. */
function excludeFileFor(gitPath: string, gitPathIsDir: boolean): string | undefined {
  if (gitPathIsDir) return path.join(gitPath, "info", "exclude");
  const pointer = readSmallText(gitPath);
  const match = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer) : null;
  if (!match?.[1]) return undefined;
  const gitDir = path.resolve(path.dirname(gitPath), match[1].trim());
  const common = readSmallText(path.join(gitDir, "commondir"));
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  return path.join(commonDir, "info", "exclude");
}

function findGitRoot(start: string): { root: string; gitPath: string; isDir: boolean } | undefined {
  let dir = start;
  for (let hop = 0; hop < MAX_GIT_ROOT_HOPS; hop++) {
    const gitPath = path.join(dir, ".git");
    const st = fs.lstatSync(gitPath, { throwIfNoEntry: false });
    if (st && (st.isDirectory() || st.isFile())) return { root: dir, gitPath, isDir: st.isDirectory() };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function matchesRule(rule: IgnoreRule, sub: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.literal !== undefined) {
    const slash = sub.lastIndexOf("/");
    return (slash === -1 ? sub : sub.slice(slash + 1)) === rule.literal;
  }
  if (rule.anchored) return rule.re!.test(sub);
  const slash = sub.lastIndexOf("/");
  return rule.re!.test(slash === -1 ? sub : sub.slice(slash + 1));
}

/** Last matching rule wins; deeper files outrank shallower ones. */
function evaluate(frame: IgnoreFrame, matchRel: string, isDir: boolean): boolean {
  for (let s = frame.length - 1; s >= 0; s--) {
    const set = frame[s] as RuleSet;
    let sub: string;
    if (set.base === "") sub = matchRel;
    else if (matchRel.startsWith(`${set.base}/`)) sub = matchRel.slice(set.base.length + 1);
    else continue;
    for (let r = set.rules.length - 1; r >= 0; r--) {
      const rule = set.rules[r] as IgnoreRule;
      if (matchesRule(rule, sub, isDir)) return !rule.negated;
    }
  }
  return false;
}

/**
 * Ignore rules for one workspace. Paths given to it are workspace-relative with
 * "/" separators. Rules are evaluated relative to the enclosing git root, so a
 * workspace opened at a subdirectory still honors the repository's ignores —
 * unless those ignores cover the workspace itself, in which case the user
 * opened an ignored tree on purpose and only its own files apply.
 */
export class WorkspaceIgnore {
  private readonly frames = new Map<string, IgnoreFrame>();

  private constructor(
    private readonly workspaceReal: string,
    /** Workspace path relative to the match root ("" when they coincide). */
    private readonly prefix: string,
    private readonly outerFrame: IgnoreFrame,
  ) {}

  static forWorkspace(workspace: string): WorkspaceIgnore {
    let workspaceReal: string;
    try {
      workspaceReal = fs.realpathSync(workspace);
    } catch {
      workspaceReal = path.resolve(workspace);
    }
    const git = findGitRoot(workspaceReal);
    if (!git) return new WorkspaceIgnore(workspaceReal, "", []);
    const exclude = excludeFileFor(git.gitPath, git.isDir);
    const outer: RuleSet[] = [];
    const excludeRules = exclude ? loadIgnoreFile(exclude) : [];
    if (excludeRules.length > 0) outer.push({ base: "", rules: excludeRules });
    const prefix = toPosix(path.relative(git.root, workspaceReal));
    if (prefix === "") return new WorkspaceIgnore(workspaceReal, "", outer);

    const segments = prefix.split("/");
    // Every directory from the git root down to (not including) the workspace.
    for (let k = 0; k < segments.length; k++) {
      const base = segments.slice(0, k).join("/");
      const rules = loadIgnoreFile(path.join(git.root, ...segments.slice(0, k), ".gitignore"));
      if (rules.length > 0) outer.push({ base, rules });
    }
    for (let k = 1; k <= segments.length; k++) {
      if (evaluate(outer, segments.slice(0, k).join("/"), true)) {
        return new WorkspaceIgnore(workspaceReal, "", []);
      }
    }
    return new WorkspaceIgnore(workspaceReal, prefix, outer);
  }

  /** The workspace-relative path a filesystem path inside the workspace has. */
  relativePath(absPath: string): string {
    return toPosix(path.relative(this.workspaceReal, absPath));
  }

  /** Rules applying to the entries of `dirRel`, including `dirRel`'s own `.gitignore`. */
  frameFor(dirRel: string): IgnoreFrame {
    const cached = this.frames.get(dirRel);
    if (cached) return cached;
    const frame =
      dirRel === ""
        ? this.withOwnFile(this.outerFrame, "")
        : this.withOwnFile(this.frameFor(dirRel.slice(0, Math.max(0, dirRel.lastIndexOf("/")))), dirRel);
    this.frames.set(dirRel, frame);
    return frame;
  }

  /** `frameFor` for a child directory reached by a walk (its parent frame in hand). */
  descend(parent: IgnoreFrame, dirRel: string): IgnoreFrame {
    const frame = this.withOwnFile(parent, dirRel);
    this.frames.set(dirRel, frame);
    return frame;
  }

  /** Whether one entry is ignored by the rules in `frame` (its parents are not consulted). */
  ignores(frame: IgnoreFrame, rel: string, isDir: boolean): boolean {
    return evaluate(frame, joinRel(this.prefix, rel), isDir);
  }

  /**
   * Whether `rel` is ignored, counting an ignored directory between `fromDir`
   * (exclusive — the caller chose it) and `rel` as ignoring everything below.
   */
  isIgnored(rel: string, isDir: boolean, fromDir = ""): boolean {
    if (rel === fromDir) return false;
    const inside = fromDir === "" ? rel : rel.slice(fromDir.length + 1);
    const parts = inside.split("/");
    let dir = fromDir;
    for (let k = 0; k < parts.length; k++) {
      const name = joinRel(dir, parts[k] as string);
      const last = k === parts.length - 1;
      if (this.ignores(this.frameFor(dir), name, last ? isDir : true)) return true;
      dir = name;
    }
    return false;
  }

  private withOwnFile(parent: IgnoreFrame, dirRel: string): IgnoreFrame {
    const rules = loadIgnoreFile(path.join(this.workspaceReal, ...dirRel.split("/").filter(Boolean), ".gitignore"));
    if (rules.length === 0) return parent;
    return [...parent, { base: joinRel(this.prefix, dirRel), rules }];
  }
}
