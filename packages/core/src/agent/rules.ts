/**
 * Rules-file hierarchy: layered instruction files merged into one "project
 * rules" block for the system prompt, plus rules that load mid-run.
 *
 * Always loaded, in this order (later = closer to the work = wins):
 *   1. ~/.seekforge/AGENTS.md               — user-global
 *   2. ~/.claude/CLAUDE.md                  — user-global, `claudeCompat: "all"` only
 *   3. <workspace>/AGENTS.md                — project rules (committed)
 *   4. <workspace>/CLAUDE.md, .claude/CLAUDE.md          — Claude Code compat
 *   5. <workspace>/AGENTS.local.md          — personal overrides (gitignore it)
 *   6. <workspace>/CLAUDE.local.md          — Claude Code compat
 *   7. .seekforge/rules/**\/*.md, then .claude/rules/**\/*.md (compat) without `paths:`
 *
 * Loaded when relevant:
 *   - <subdir>/AGENTS.md (and CLAUDE.md under compat): in the system prompt
 *     when the task names a path under the subdir, and otherwise injected once
 *     the run reads or edits a file below it;
 *   - rules files with a `paths:` frontmatter list: injected once the run
 *     reads or edits a file matching one of the globs.
 *
 * A line that is just `@path` imports another file (see util/line-imports.ts):
 * relative to the including file, confined to the workspace for project files
 * and to the home directory for user files (where `@~/x` also works). Imports
 * of sensitive files are refused. Missing or empty files are skipped; an
 * oversized file (after imports) is skipped whole rather than injected in part;
 * identical content is included once.
 */

import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { compareByCodePoints, type ChatMessage, isSensitiveBasename, isSensitiveRelPath } from "@seekforge/shared";
import { taskPathTokens } from "../memory/index.js";
import { compileGlob } from "../tools/builtins/glob.js";
import { WorkspaceIgnore } from "../tools/gitignore.js";
import { DEFAULT_IGNORE_DIRS, resolveInsideWorkspace } from "../tools/sandbox.js";
import { expandLineImports } from "../util/line-imports.js";
import { readWorkspaceStateFile } from "../util/workspace-state.js";

export type RuleFile = {
  /** Display origin used in the section header (e.g. "~/.seekforge/AGENTS.md"). */
  origin: string;
  content: string;
};

/**
 * Which Claude Code instruction files SeekForge reads: none, the project's
 * (the default), or the project's plus `~/.claude/CLAUDE.md`. Only a
 * user-owned config layer can set it — repository layers drop the key.
 */
export type ClaudeCompat = "off" | "project" | "all";
export const CLAUDE_COMPAT_MODES: readonly ClaudeCompat[] = ["off", "project", "all"];

export type RuleOptions = { claudeCompat?: ClaudeCompat };

/** Oversized rule files are skipped rather than partially injecting instructions. */
export const MAX_RULE_FILE_BYTES = 256 * 1024;
/** Includes origin headers and separators across global/project/local/subdir rules. */
export const MAX_RULES_TOTAL_BYTES = 384 * 1024;
/** Rules loaded mid-run share this smaller allowance: they land in an already-busy window. */
export const MAX_ACTIVATED_RULES_BYTES = 64 * 1024;
const MAX_IMPORT_DEPTH = 5;

// --- reading with imports ----------------------------------------------------

type RuleRoot = {
  /** Directory every read is physically confined to. */
  dir: string;
  /** The root is the home directory, where `@~/…` resolves. */
  home: boolean;
};

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function isSensitiveImport(rel: string): boolean {
  return isSensitiveBasename(basename(rel)) || isSensitiveRelPath(toPosix(rel));
}

function resolveImport(root: RuleRoot, spec: string, fromRel: string): string | undefined {
  let rel: string;
  if (spec === "~" || spec.startsWith("~/")) {
    if (!root.home) return undefined; // a repository may not reach into the home directory
    rel = normalize(spec.slice(2));
  } else {
    if (isAbsolute(spec)) return undefined;
    rel = normalize(join(dirname(fromRel), spec));
  }
  if (rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  if (isSensitiveImport(rel)) return undefined;
  return rel;
}

function readRaw(root: string, relPath: string): string | undefined {
  try {
    return readWorkspaceStateFile(root, relPath, MAX_RULE_FILE_BYTES);
  } catch {
    return undefined;
  }
}

/**
 * `raw` (the file `relPath`) with imports expanded, or undefined when empty or
 * oversized. Imports of files in `visited` are dropped; the ones this file
 * pulls in are added to it.
 */
function expandRule(root: RuleRoot, visited: Set<string>, relPath: string, raw: string): string | undefined {
  if (raw.trim().length === 0) return undefined;
  const self = normalize(relPath);
  visited.add(self);
  const budget = { remaining: MAX_RULE_FILE_BYTES };
  const expanded = expandLineImports(raw, self, {
    resolve: (spec, fromRel) => resolveImport(root, spec, fromRel),
    read: (rel) => readRaw(root.dir, rel),
    maxDepth: MAX_IMPORT_DEPTH,
    budget,
    visited,
    skipCodeFences: true,
    keepUnresolved: true,
  }).trim();
  if (budget.remaining <= 0 || Buffer.byteLength(expanded, "utf8") > MAX_RULE_FILE_BYTES) return undefined;
  return expanded.length > 0 ? expanded : undefined;
}

// --- frontmatter -------------------------------------------------------------

/** Split on commas that are not inside braces or quotes ("src/**\/*.{ts,tsx}" is one glob). */
function splitList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items;
}

function unquote(item: string): string {
  const trimmed = item.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to a plain strip
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "");
}

/**
 * A rules file's `paths:` list and body. `paths` may be a YAML block list, a
 * flow list (`[a, b]`), or a comma-separated string. Absent (or empty) means
 * the rule always applies.
 */
export function parseRuleFrontmatter(markdown: string): { paths: string[]; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m) return { paths: [], body: markdown };
  const lines = (m[1] as string).split(/\r?\n/);
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const field = /^paths[ \t]*:[ \t]*(.*)$/.exec(lines[i] as string);
    if (!field) continue;
    let value = (field[1] as string).trim();
    if (value === "" || value.startsWith("#")) {
      while (i + 1 < lines.length) {
        const next = lines[i + 1] as string;
        const item = /^\s*-\s*(.*)$/.exec(next);
        if (item) {
          paths.push(unquote(item[1] as string));
          i++;
        } else if (next.trim() === "" || next.trim().startsWith("#")) {
          i++;
        } else {
          break;
        }
      }
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
    for (const item of splitList(value)) paths.push(unquote(item));
  }
  return { paths: paths.filter((p) => p.length > 0), body: markdown.slice(m[0].length) };
}

// --- path-scoped rule files ----------------------------------------------------

const RULES_DIRS: ReadonlyArray<{ rel: string; compat: boolean }> = [
  { rel: join(".seekforge", "rules"), compat: false },
  { rel: join(".claude", "rules"), compat: true },
];
const MAX_RULES_DIR_DEPTH = 6;
const MAX_RULES_DIR_FILES = 64;

/** A rules file whose `paths:` globs decide when it loads. */
export type ScopedRule = {
  origin: string;
  paths: string[];
  text: string;
  matchers: Array<{ re: RegExp; basenameOnly: boolean }>;
};

function listRuleFiles(workspace: string, relDir: string): string[] {
  const files: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_RULES_DIR_DEPTH || files.length >= MAX_RULES_DIR_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(workspace, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareByCodePoints(a.name, b.name));
    for (const entry of entries) {
      if (files.length >= MAX_RULES_DIR_FILES) return;
      const child = join(rel, entry.name);
      // Dirent types come from lstat: symlinks are neither, and are skipped.
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(child);
    }
  };
  walk(relDir, 1);
  return files;
}

function compileRulePaths(paths: string[]): ScopedRule["matchers"] {
  const matchers: ScopedRule["matchers"] = [];
  for (const raw of paths) {
    const pattern = raw.replace(/^\.?\//, "");
    if (pattern === "") continue;
    try {
      matchers.push({ re: compileGlob(pattern), basenameOnly: !pattern.includes("/") });
    } catch {
      // an invalid glob matches nothing
    }
  }
  return matchers;
}

function ruleMatches(rule: ScopedRule, rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return rule.matchers.some((m) => m.re.test(m.basenameOnly ? name : rel));
}

// --- subdirectory rules --------------------------------------------------------

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

function subdirRuleNames(compat: ClaudeCompat): string[] {
  return compat === "off" ? ["AGENTS.md"] : ["AGENTS.md", "CLAUDE.md"];
}

/** A subdir rules file plus the workspace-relative dir it was found in. */
type SubdirRule = { relDir: string; name: string; raw: string };

/**
 * Discovers rules files in SUBDIRECTORIES of `workspace` (the root's own are
 * handled by the layers, not here). Bounded by depth, file count, and an
 * exclude list; tolerates any fs error (best-effort).
 */
function scanSubdirRules(workspace: string, compat: ClaudeCompat): SubdirRule[] {
  const results: SubdirRule[] = [];
  const names = subdirRuleNames(compat);
  const ignore = WorkspaceIgnore.forWorkspace(workspace);
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
      if (isExcludedSegment(entry.name)) continue;
      const childDir = join(dir, entry.name);
      const relDir = relative(workspace, childDir);
      if (ignore.isIgnored(toPosix(relDir), true)) continue;
      for (const name of names) {
        const raw = readRaw(workspace, join(relDir, name));
        if (raw !== undefined && raw.trim().length > 0) {
          results.push({ relDir, name, raw });
          if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
        }
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
  const norm = toPosix(relDir).toLowerCase();
  if (norm.length === 0) return false;
  const prefix = `${norm}/`;
  return pathTokens.some((t) => t === norm || t.startsWith(prefix));
}

/** A directory whose rules files are never loaded: dependencies, build output, dot-dirs. */
function isExcludedSegment(name: string): boolean {
  return SUBDIR_SCAN_EXCLUDE.has(name) || DEFAULT_IGNORE_DIRS.has(name) || name.startsWith(".");
}

// --- collection ------------------------------------------------------------------

function block(origin: string, content: string): string {
  return `<!-- from: ${origin} -->\n${content}`;
}

/** Accumulates blocks under a byte cap, dropping exact duplicates. */
class BlockSet {
  readonly blocks: string[] = [];
  readonly origins: string[] = [];
  bytes = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly cap: number) {}

  add(origin: string, content: string): "added" | "duplicate" | "over_budget" {
    if (this.seen.has(content)) return "duplicate";
    const text = block(origin, content);
    const contribution = Buffer.byteLength(text, "utf8") + (this.blocks.length > 0 ? 2 : 0);
    if (this.bytes + contribution > this.cap) return "over_budget";
    this.seen.add(content);
    this.blocks.push(text);
    this.origins.push(origin);
    this.bytes += contribution;
    return "added";
  }
}

type Layer = { origin: string; user: boolean; relPath: string };

function rootLayers(compat: ClaudeCompat): Layer[] {
  const claude = compat !== "off";
  const layers: Array<Layer | false> = [
    { origin: "~/.seekforge/AGENTS.md", user: true, relPath: join(".seekforge", "AGENTS.md") },
    compat === "all" && { origin: "~/.claude/CLAUDE.md", user: true, relPath: join(".claude", "CLAUDE.md") },
    { origin: "AGENTS.md", user: false, relPath: "AGENTS.md" },
    claude && { origin: "CLAUDE.md", user: false, relPath: "CLAUDE.md" },
    claude && { origin: ".claude/CLAUDE.md", user: false, relPath: join(".claude", "CLAUDE.md") },
    { origin: "AGENTS.local.md", user: false, relPath: "AGENTS.local.md" },
    claude && { origin: "CLAUDE.local.md", user: false, relPath: "CLAUDE.local.md" },
  ];
  return layers.filter((layer): layer is Layer => layer !== false);
}

/** One filesystem root and the files already included from it. */
type RootState = { root: RuleRoot; visited: Set<string> };

/**
 * Expand `relPath` (or the given `raw` text of it) and add it to `set`. The
 * imports it pulled in count as included only when the block itself was: a
 * file skipped for size must not make a later file drop the same import.
 */
function addRuleFile(
  set: BlockSet,
  state: RootState,
  origin: string,
  relPath: string,
  raw?: string,
): { outcome: "added" | "duplicate" | "over_budget" | "absent"; text?: string } {
  const source = raw ?? readRaw(state.root.dir, relPath);
  if (source === undefined) return { outcome: "absent" };
  const trial = new Set(state.visited);
  const text = expandRule(state.root, trial, relPath, source);
  if (text === undefined) return { outcome: "absent" };
  const outcome = set.add(origin, text);
  if (outcome !== "over_budget") for (const key of trial) state.visited.add(key);
  return { outcome, text };
}

function rootStates(workspace: string, home: string): { user: RootState; project: RootState } {
  return {
    user: { root: { dir: home, home: true }, visited: new Set() },
    project: { root: { dir: workspace, home: false }, visited: new Set() },
  };
}

/** Rules for one run: the system-prompt block and what may still load later. */
export type ProjectRules = {
  /** The system-prompt block, or undefined when nothing applies. */
  text: string | undefined;
  /** Origins already in `text`. */
  included: string[];
  /** Bytes `text` occupies. */
  bytes: number;
  /** Rules files with `paths:` waiting for a matching file. */
  scoped: ScopedRule[];
  claudeCompat: ClaudeCompat;
  /** Workspace files `text` already contains, so later rules do not import them again. */
  importedFiles: ReadonlySet<string>;
};

/**
 * Loads every rules source for `workspace`. `task` enables the task-path
 * trigger for subdirectory rules (see collectProjectRules).
 */
export function loadProjectRules(
  workspace: string,
  opts: RuleOptions & { home?: string; task?: string } = {},
): ProjectRules {
  const compat = opts.claudeCompat ?? "project";
  const set = new BlockSet(MAX_RULES_TOTAL_BYTES);
  const states = rootStates(workspace, opts.home ?? homedir());
  for (const layer of rootLayers(compat)) {
    addRuleFile(set, layer.user ? states.user : states.project, layer.origin, layer.relPath);
  }

  const scopedSources: Array<{ origin: string; rel: string; paths: string[]; body: string }> = [];
  for (const dir of RULES_DIRS) {
    if (dir.compat && compat === "off") continue;
    for (const rel of listRuleFiles(workspace, dir.rel)) {
      const raw = readRaw(workspace, rel);
      if (raw === undefined) continue;
      const { paths, body } = parseRuleFrontmatter(raw);
      const origin = toPosix(rel);
      if (paths.length === 0) addRuleFile(set, states.project, origin, rel, body);
      else scopedSources.push({ origin, rel, paths, body });
    }
  }

  if (opts.task && opts.task.trim().length > 0) {
    let pathTokens: string[] = [];
    try {
      pathTokens = taskPathTokens(opts.task).map((t) => t.toLowerCase());
    } catch {
      pathTokens = [];
    }
    if (pathTokens.length > 0) {
      for (const sub of scanSubdirRules(workspace, compat)) {
        if (!taskReferencesSubdir(sub.relDir, pathTokens)) continue;
        addRuleFile(set, states.project, `${toPosix(sub.relDir)}/${sub.name}`, join(sub.relDir, sub.name), sub.raw);
      }
    }
  }

  // Each scoped rule may load without the others, so none may count on
  // another having imported a file first.
  const scoped: ScopedRule[] = [];
  for (const source of scopedSources) {
    const matchers = compileRulePaths(source.paths);
    if (matchers.length === 0) continue;
    const text = expandRule(states.project.root, new Set(states.project.visited), source.rel, source.body);
    if (text !== undefined) scoped.push({ origin: source.origin, paths: source.paths, text, matchers });
  }

  return {
    text: set.blocks.length > 0 ? set.blocks.join("\n\n") : undefined,
    included: set.origins,
    bytes: set.bytes,
    scoped,
    claudeCompat: compat,
    importedFiles: states.project.visited,
  };
}

/** Loads each always-on root rules layer that exists and is non-empty, in precedence order. */
export function collectRuleFiles(workspace: string, homeOverride?: string, opts: RuleOptions = {}): RuleFile[] {
  const compat = opts.claudeCompat ?? "project";
  const set = new BlockSet(MAX_RULES_TOTAL_BYTES);
  const states = rootStates(workspace, homeOverride ?? homedir());
  const out: RuleFile[] = [];
  for (const layer of rootLayers(compat)) {
    const { outcome, text } = addRuleFile(set, layer.user ? states.user : states.project, layer.origin, layer.relPath);
    if (outcome === "added" && text !== undefined) out.push({ origin: layer.origin, content: text });
  }
  return out;
}

/**
 * Concatenates all present rules layers, each prefixed by an origin header
 * comment. Returns undefined when no layer contributes anything.
 *
 * When `task` is given, a subdirectory's AGENTS.md is appended ONLY if the task
 * references a path under that subdir (path-scoped; keeps the always-injected
 * rules from bloating the prompt). The run can still load it later — see
 * createRuleActivation.
 */
export function collectProjectRules(
  workspace: string,
  homeOverride?: string,
  task?: string,
  opts: RuleOptions = {},
): string | undefined {
  return loadProjectRules(workspace, {
    ...opts,
    ...(homeOverride !== undefined ? { home: homeOverride } : {}),
    ...(task !== undefined ? { task } : {}),
  }).text;
}

// --- mid-run activation ----------------------------------------------------------

/** Tools whose target file makes rules for that file relevant. */
export const RULE_TRIGGER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "notebook_read",
  "notebook_edit",
]);

export type RuleInjection = {
  /** The transient message to add before the next model turn. */
  message: string;
  origins: string[];
  /** Origins that matched but did not fit the budget. */
  skipped: string[];
};

export type RuleActivation = {
  /** A tool touched `rawPath` (as the model wrote it). */
  touch(rawPath: string): void;
  /** Rules activated since the last call, as one message; undefined when none. */
  takePending(): RuleInjection | undefined;
  /**
   * After compaction: the activated rules no longer anywhere in `messages`,
   * as one message to re-add; undefined when all survived.
   */
  reinject(messages: readonly ChatMessage[]): RuleInjection | undefined;
};

const INJECTION_HEADER =
  "[harness] Project rules for files you are working on. They carry the same authority as AGENTS.md; follow them for this work:";

/**
 * Tracks which subdirectory and path-scoped rules a run has touched, and hands
 * each to the model once. One per run: the loop creates it after building the
 * system prompt, whose already-included rules it will not repeat.
 */
export function createRuleActivation(workspace: string, rules: ProjectRules): RuleActivation {
  let workspaceReal = workspace;
  try {
    workspaceReal = resolveInsideWorkspace(workspace, ".");
  } catch {
    // keep the given path
  }
  const projectRoot: RuleRoot = { dir: workspace, home: false };
  const handled = new Set(rules.included);
  const checkedDirs = new Set<string>();
  const pending: Array<{ origin: string; text: string }> = [];
  const injected: Array<{ origin: string; block: string }> = [];
  const names = subdirRuleNames(rules.claudeCompat);
  let activatedBytes = 0;
  const seenContent = new Set<string>();

  const queue = (origin: string, text: string): void => {
    handled.add(origin);
    pending.push({ origin, text });
  };

  const nestedRules = (rel: string): void => {
    const parts = rel.split("/");
    let ignore: WorkspaceIgnore | undefined;
    for (let k = 1; k < parts.length; k++) {
      if (isExcludedSegment(parts[k - 1] as string)) return;
      const dir = parts.slice(0, k).join("/");
      if (checkedDirs.has(dir)) continue;
      checkedDirs.add(dir);
      ignore ??= WorkspaceIgnore.forWorkspace(workspace);
      // An ignored tree (a virtualenv, generated code) is not the project's to instruct.
      if (ignore.isIgnored(dir, true)) return;
      for (const name of names) {
        const origin = `${dir}/${name}`;
        if (handled.has(origin)) continue;
        const relPath = join(...parts.slice(0, k), name);
        const raw = readRaw(workspace, relPath);
        const text =
          raw === undefined ? undefined : expandRule(projectRoot, new Set(rules.importedFiles), relPath, raw);
        if (text !== undefined) queue(origin, text);
      }
    }
  };

  return {
    touch(rawPath) {
      let rel: string;
      try {
        rel = toPosix(relative(workspaceReal, resolveInsideWorkspace(workspace, rawPath)));
      } catch {
        return;
      }
      if (rel === "" || rel.startsWith("../")) return;
      try {
        nestedRules(rel);
      } catch {
        // best effort: rules discovery never fails a tool call
      }
      for (const rule of rules.scoped) {
        if (!handled.has(rule.origin) && ruleMatches(rule, rel)) queue(rule.origin, rule.text);
      }
    },

    takePending() {
      if (pending.length === 0) return undefined;
      const blocks: string[] = [];
      const origins: string[] = [];
      const skipped: string[] = [];
      for (const { origin, text } of pending.splice(0)) {
        if (seenContent.has(text)) continue;
        const scoped = rules.scoped.find((rule) => rule.origin === origin);
        const label = scoped ? `${origin} (paths: ${scoped.paths.join(", ")})` : origin;
        const entry = block(label, text);
        const bytes = Buffer.byteLength(entry, "utf8") + 2;
        if (
          activatedBytes + bytes > MAX_ACTIVATED_RULES_BYTES ||
          rules.bytes + activatedBytes + bytes > MAX_RULES_TOTAL_BYTES
        ) {
          skipped.push(origin);
          continue;
        }
        activatedBytes += bytes;
        seenContent.add(text);
        blocks.push(entry);
        origins.push(origin);
        injected.push({ origin, block: entry });
      }
      if (blocks.length === 0 && skipped.length === 0) return undefined;
      return {
        message: blocks.length > 0 ? `${INJECTION_HEADER}\n\n${blocks.join("\n\n")}` : "",
        origins,
        skipped,
      };
    },

    reinject(messages) {
      const missing = injected.filter(
        ({ block: entry }) => !messages.some((m) => m.role === "user" && m.content.includes(entry)),
      );
      if (missing.length === 0) return undefined;
      return {
        message: `${INJECTION_HEADER}\n\n${missing.map((m) => m.block).join("\n\n")}`,
        origins: missing.map((m) => m.origin),
        skipped: [],
      };
    },
  };
}
