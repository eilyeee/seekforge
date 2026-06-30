import * as fs from "node:fs";
import * as path from "node:path";
import { taskKeywords, taskPathTokens } from "../memory/brief.js";
import { DEFAULT_IGNORE_DIRS } from "../tools/sandbox.js";

/**
 * Repo map: a compact, token-budgeted structural overview of a (possibly large)
 * codebase, so the agent can orient WITHOUT reading every file. Two sections:
 *
 *   Structure — directory tree (to maxDepth) with per-directory code-file counts.
 *   Files     — up to maxFiles code files, each with a one-line symbol outline
 *               (exports / component name), breadth-first so entry points and
 *               shallow modules come first.
 *
 * Pure-ish: reads the filesystem read-only, never writes. Heuristic symbol
 * extraction (regex, no parser dependency) — good enough to point the agent at
 * the right file, not a substitute for reading it.
 */

export type RepoMapOptions = {
  /** Subtree to map, relative to root (default "."). Narrow this on huge trees. */
  path?: string;
  /** Directory-tree depth for the Structure section (default 3). */
  maxDepth?: number;
  /** Max files given a detailed symbol outline in the Files section (default 60). */
  maxFiles?: number;
};

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "py", "go", "rs", "java", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs",
]);
/** Files this large are summarized by size only (avoid pathological reads). */
const MAX_READ_BYTES = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 8;

type CodeFile = { rel: string; depth: number; size: number };

function isCode(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && CODE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** Resolve a subtree path under root; null if it escapes the root (no traversal). */
function resolveSubtree(root: string, sub: string): string | null {
  const base = path.resolve(root);
  const start = path.resolve(base, sub);
  return start === base || start.startsWith(base + path.sep) ? start : null;
}

/** Walk a directory collecting code files (rel to root) and per-dir counts. */
function walk(root: string, start: string): { files: CodeFile[]; dirCounts: Map<string, number> } {
  const files: CodeFile[] = [];
  const dirCounts = new Map<string, number>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile() && isCode(e.name)) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs);
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        files.push({ rel, depth: rel.split(path.sep).length, size });
        // credit every ancestor directory (relative to root) with this file.
        let d = path.dirname(rel);
        while (true) {
          const key = d === "." ? "." : d;
          dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
          if (d === "." || d === "") break;
          const parent = path.dirname(d);
          if (parent === d) break;
          d = parent;
        }
      }
    }
  }
  return { files, dirCounts };
}

/** Regex symbol outline — the dependency-free floor backend. */
function regexOutline(rel: string, content: string): string {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "vue" || ext === "svelte") {
    const nameM = content.match(/name\s*:\s*["']([^"']+)["']/);
    const setup = /<script[^>]*\bsetup\b/.test(content);
    const label = nameM ? `name=${nameM[1]}` : "anonymous";
    return `[${ext} ${label}${setup ? ", setup" : ""}]`;
  }
  const names = new Set<string>();
  for (const m of content.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.add(m[1]!);
  }
  for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const n = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }
  for (const m of content.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const n = part.trim().split(":")[0]!.trim();
      if (/^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }
  // Python / Go fall back to top-level def/func.
  for (const m of content.matchAll(/^\s*(?:def|func)\s+([A-Za-z0-9_]+)/gm)) names.add(m[1]!);
  const list = [...names].slice(0, MAX_SYMBOLS_PER_FILE);
  return list.length > 0 ? `exports: ${list.join(", ")}` : "";
}

/** Regex definition scan for one file — the floor backend. */
function regexDefinitions(_rel: string, content: string, symbol: string): { line: number; text: string }[] {
  // Escape regex metacharacters so any identifier (incl. `$`) interpolates safely.
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = symbol; // unescaped, for the cheap substring prefilter
  const re = new RegExp(
    [
      `(?:function|class|const|let|var|type|interface|enum)\\s+${s}\\b`,
      `(?:def|func)\\s+${s}\\b`,
      `\\b${s}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`,
      `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${s}\\b`,
      `^\\s*${s}\\s*\\([^)]*\\)\\s*\\{`,
    ].join("|"),
  );
  const out: { line: number; text: string }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(raw)) continue; // cheap prefilter (unescaped)
    if (re.test(line)) out.push({ line: i + 1, text: line.trim().slice(0, 200) });
  }
  return out;
}

/**
 * A pluggable symbol backend. The resolver tries backends in order and uses the
 * first that handles a file (returns non-undefined). The regex backend is the
 * guaranteed floor; a tree-sitter backend can be PREPENDED to symbolBackends for
 * accurate, scope-aware extraction without touching callers — it returns
 * undefined for files/languages it can't parse, falling through to regex.
 */
export type DeclRange = { start: number; end: number };

export type SymbolBackend = {
  name: string;
  /** One-line outline for a file, or undefined to defer to the next backend. */
  outline(rel: string, content: string): string | undefined;
  /** Definition sites of `symbol` in a file, or undefined to defer. */
  definitions(rel: string, content: string, symbol: string): { line: number; text: string }[] | undefined;
  /**
   * Char ranges of the file's TOP-LEVEL constructs (functions, classes, …), so
   * truncation can cut between them instead of mid-construct. Undefined when the
   * backend can't parse the file (only an AST backend implements this).
   */
  ranges?(rel: string, content: string): DeclRange[] | undefined;
};

const regexBackend: SymbolBackend = {
  name: "regex",
  outline: regexOutline,
  definitions: regexDefinitions,
};

/** Active backends, highest priority first. Prepend an AST backend; regex stays the fallback. */
export const symbolBackends: SymbolBackend[] = [regexBackend];

function resolveOutline(rel: string, content: string): string {
  for (const b of symbolBackends) {
    const r = b.outline(rel, content);
    if (r !== undefined) return r;
  }
  return "";
}

function resolveDefinitions(rel: string, content: string, symbol: string): { line: number; text: string }[] {
  for (const b of symbolBackends) {
    const r = b.definitions(rel, content, symbol);
    if (r !== undefined) return r;
  }
  return [];
}

/**
 * Top-level construct char ranges (for code-aware truncation), or undefined if
 * no backend can parse the file (e.g. tree-sitter not loaded). Regex has no
 * reliable ranges, so this is effectively AST-only.
 */
export function declRanges(rel: string, content: string): DeclRange[] | undefined {
  for (const b of symbolBackends) {
    const r = b.ranges?.(rel, content);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** One-line symbol outline for a file (regex floor; an AST backend may override). */
export function extractSymbols(rel: string, content: string): string {
  return resolveOutline(rel, content);
}

function outlineFor(abs: string, rel: string, size: number): string {
  if (size > MAX_READ_BYTES) return `(${Math.round(size / 1024)}KB)`;
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n").length;
  const sym = extractSymbols(rel, content);
  return `${sym}${sym ? "  " : ""}(${lines} ln)`.trim();
}

/** Build the repo map string for `root` (an absolute directory). */
export function buildRepoMap(root: string, opts: RepoMapOptions = {}): string {
  const sub = opts.path && opts.path !== "." ? opts.path : ".";
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = opts.maxFiles ?? 60;
  const start = resolveSubtree(root, sub);
  if (start === null) return `Repo map: "${sub}" is outside the workspace.`;
  const { files, dirCounts } = walk(root, start);
  return formatRepoMap(root, sub, files, dirCounts, maxDepth, maxFiles);
}

/** A single tree scan, shareable across the prompt-injection builders below. */
export type RepoScan = { files: CodeFile[]; dirCounts: Map<string, number> };

/** Walk the tree once; pass the result to both builders to avoid a double walk. */
export function scanRepo(root: string): RepoScan {
  return walk(root, root);
}

/**
 * Compact top-level overview for auto-injection into the system prompt at
 * session start. Returns undefined for small repos (not worth the tokens) or
 * when the tree can't be read. Reuses a shared scan when provided.
 */
export function buildRepoOverview(root: string, minFiles = 150, scan?: RepoScan): string | undefined {
  const { files, dirCounts } = scan ?? walk(root, root);
  if (files.length < minFiles) return undefined;
  return formatRepoMap(root, ".", files, dirCounts, 2, 25);
}

/**
 * Task-relevant file retrieval for prompt injection — the transparent
 * counterpart to buildRepoOverview. The overview is breadth-first and
 * task-agnostic ("here is the repo"); this is task-targeted ("here is where to
 * look for THIS task"): it ranks code files by lexical overlap of their PATH
 * and symbol outline with the task, and returns the strongest matches with a
 * one-line outline each.
 *
 * Scoring (reuses the memory-brief tokenizers so CJK tasks work):
 *   +4 per task path-token found in the file path (e.g. "auth/session.ts"),
 *   +3 per task keyword that IS a whole path segment, +1 if only a substring,
 *   then, for the top path-matches only, +2 / +1 for path-token / keyword hits
 *   in the file's symbol outline.
 *
 * Deliberately a CHEAP orientation hint, not a search engine: a file whose
 * relevance lives only in its CONTENTS (not its name/exports) won't surface —
 * that is what search_text is for. Returns undefined when the task has no
 * specific terms, the tree is small enough to navigate directly, or nothing
 * clears the relevance floor (silence beats noise, like buildMemoryBrief).
 *
 * Cost is bounded: path scoring reads no files; only the top `maxCandidates`
 * path-matches are read to refine with symbol matches.
 */
export function buildRelevantFiles(
  root: string,
  task: string,
  opts: { maxFiles?: number; maxCandidates?: number; minScore?: number; minRepoFiles?: number } = {},
  scan?: RepoScan,
): string | undefined {
  const keywords = taskKeywords(task);
  const pathTokens = taskPathTokens(task);
  if (keywords.length === 0 && pathTokens.length === 0) return undefined;
  const maxFiles = opts.maxFiles ?? 8;
  const maxCandidates = opts.maxCandidates ?? 24;
  const minScore = opts.minScore ?? 3;
  const minRepoFiles = opts.minRepoFiles ?? 40;

  const { files } = scan ?? walk(root, path.resolve(root));
  // Small trees are navigable directly (and the hint would be mostly noise).
  if (files.length < minRepoFiles) return undefined;

  // Stage 1 — PATH-only scoring (no file reads).
  const pathScored: { f: CodeFile; score: number }[] = [];
  for (const f of files) {
    const lower = f.rel.toLowerCase();
    const segs = new Set(lower.split(/[/\\.\-_]+/u).filter(Boolean));
    let score = 0;
    // Boundary-aware: a path token must match a full path component, not be an
    // arbitrary substring — else "index.ts" spuriously hits "reindex.ts" and
    // "auth.ts" hits "oauth.ts", injecting unrelated files into the shortlist.
    for (const pt of pathTokens) if (lower.startsWith(pt) || lower.includes(`/${pt}`)) score += 4;
    for (const kw of keywords) {
      if (segs.has(kw)) score += 3;
      else if (lower.includes(kw)) score += 1;
    }
    if (score > 0) pathScored.push({ f, score });
  }
  if (pathScored.length === 0) return undefined;

  // Stage 2 — read the top path-matches and refine with symbol-outline matches.
  const candidates = pathScored
    .sort((a, b) => b.score - a.score || a.f.rel.localeCompare(b.f.rel))
    .slice(0, maxCandidates);
  const refined = candidates.map(({ f, score }) => {
    let outline = "";
    if (f.size <= MAX_READ_BYTES) {
      try {
        const content = fs.readFileSync(path.resolve(root, f.rel), "utf8");
        outline = extractSymbols(f.rel, content);
        const hay = outline.toLowerCase();
        for (const pt of pathTokens) if (hay.includes(pt)) score += 2;
        for (const kw of keywords) if (hay.includes(kw)) score += 1;
      } catch {
        // Unreadable -> keep the path-only score.
      }
    }
    return { rel: f.rel, outline, score };
  });

  const top = refined
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, maxFiles);
  if (top.length === 0) return undefined;

  const lines = ["# Task-relevant files (ranked by lexical match — verify by reading)"];
  for (const r of top) lines.push(`${r.rel}${r.outline ? `  ${r.outline}` : ""}`);
  return lines.join("\n");
}

function formatRepoMap(
  root: string,
  sub: string,
  files: CodeFile[],
  dirCounts: Map<string, number>,
  maxDepth: number,
  maxFiles: number,
): string {
  if (files.length === 0) return `Repo map: no code files under ${sub}.`;

  const out: string[] = [`# Repo map — ${sub} (${files.length} code files)`];

  // Structure: directories (relative to root) up to maxDepth, with counts.
  const baseDepth = sub === "." ? 0 : sub.split("/").filter(Boolean).length;
  const dirs = [...dirCounts.entries()]
    .filter(([d]) => d !== "." && d !== "")
    .filter(([d]) => d.split(path.sep).length - baseDepth <= maxDepth)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (dirs.length > 0) {
    out.push("", "## Structure");
    for (const [d, n] of dirs) {
      const indent = "  ".repeat(Math.max(0, d.split(path.sep).length - baseDepth - 1));
      out.push(`${indent}${path.basename(d)}/  (${n})`);
    }
  }

  // Files: breadth-first (shallow first), budgeted, with symbol outlines.
  out.push("", "## Files");
  const sorted = [...files].sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  for (const f of sorted.slice(0, maxFiles)) {
    const outline = outlineFor(path.resolve(root, f.rel), f.rel, f.size);
    out.push(`${f.rel}${outline ? `  ${outline}` : ""}`);
  }
  if (sorted.length > maxFiles) {
    out.push(`… and ${sorted.length - maxFiles} more files — narrow with a deeper \`path\`.`);
  }
  return out.join("\n");
}

export type Definition = { file: string; line: number; text: string };

/**
 * Find likely DEFINITION sites of `symbol` across the tree — not every mention,
 * unlike search_text. Per-file extraction routes through the symbol backends
 * (regex floor; an AST backend overrides when available). Read-only.
 */
export function findDefinitions(
  root: string,
  symbol: string,
  opts: { path?: string; maxResults?: number } = {},
): Definition[] {
  // Identifier-shaped only (unicode letters/digits ok); rejects whitespace,
  // dots, parens, etc. The regex backend additionally escapes the symbol.
  if (!/^[\p{L}\p{N}_$]+$/u.test(symbol)) return [];
  const sub = opts.path && opts.path !== "." ? opts.path : ".";
  const maxResults = opts.maxResults ?? 50;
  const start = resolveSubtree(root, sub);
  if (start === null) return [];
  const { files } = walk(root, start);
  const results: Definition[] = [];
  for (const f of files) {
    if (results.length >= maxResults) break;
    if (f.size > MAX_READ_BYTES) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(root, f.rel), "utf8");
    } catch {
      continue;
    }
    for (const d of resolveDefinitions(f.rel, content, symbol)) {
      if (results.length >= maxResults) break;
      results.push({ file: f.rel, line: d.line, text: d.text });
    }
  }
  return results;
}
