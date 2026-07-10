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

function outlineFor(abs: string, rel: string, size: number, cached?: FileGraphFileInfo): string {
  if (size > MAX_READ_BYTES) return `(${Math.round(size / 1024)}KB)`;
  // Reuse the outline + line count captured during a graph build (same
  // content, same backends) instead of re-reading the file. Only files the
  // graph actually read are cached; everything else falls through to a read.
  if (cached) return `${cached.outline}${cached.outline ? "  " : ""}(${cached.lines} ln)`.trim();
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

/* ------------------------------------------------------------------------- *
 * Dependency-graph ranking (Aider-style).
 *
 * Aider ranks a repo not by name-matching but by CENTRALITY: it builds a graph
 * whose nodes are files and whose edges A→B mean "A references a symbol DEFINED
 * in B", then runs PageRank to surface the most-referenced files. We reuse the
 * symbol outline (AST when loaded, regex floor otherwise) for definitions and a
 * cheap identifier tokenization for references — matching Aider's "file A's text
 * contains a symbol defined in file B" heuristic. The result blends with the
 * lexical score in buildRelevantFiles and orders buildRepoOverview.
 *
 * Deterministic (no Date/random), bounded (MAX_GRAPH_FILES cap + existing
 * file-count guards), and a clean no-op when the graph has no edges.
 * ------------------------------------------------------------------------- */

/** Hard cap on nodes so a huge repo can't blow up the graph build / power iteration. */
const MAX_GRAPH_FILES = 600;
const PAGERANK_ITERATIONS = 25;
const PAGERANK_DAMPING = 0.85;
const IDENT_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const IDENT_OK = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/**
 * Per-file data captured as a side effect of the graph build (which already
 * reads every file and computes its outline): enough for the downstream
 * formatting/refinement steps to skip their own re-reads. Deliberately NOT the
 * file content itself — holding up to 600 × 512KB of text alive for the whole
 * run would be a memory hazard, and outline + line count is all the consumers
 * (outlineFor, buildRelevantFiles' refine pass) actually need.
 */
export type FileGraphFileInfo = { outline: string; lines: number };

export type FileGraph = {
  /** Node ids (rel paths), sorted deterministically. */
  files: string[];
  /** Adjacency: from-file -> (to-file -> summed edge weight). */
  edges: Map<string, Map<string, number>>;
  /** False when the graph is trivial (no cross-file references) -> callers fall back to lexical. */
  hasEdges: boolean;
  /**
   * Outline + line count per file actually READ during the build (files over
   * MAX_READ_BYTES, unreadable files and files beyond the MAX_GRAPH_FILES cap
   * are absent — consumers must fall back to reading). Optional so externally
   * constructed graphs (tests, future backends) stay valid.
   */
  info?: Map<string, FileGraphFileInfo>;
};

/** Names DEFINED by a file, parsed from its symbol outline ("exports: a, b, …"). */
function definedNames(outline: string): string[] {
  if (!outline.startsWith("exports:")) return [];
  const out: string[] = [];
  for (const part of outline.slice("exports:".length).split(",")) {
    const n = part.trim();
    if (n && IDENT_OK.test(n)) out.push(n);
  }
  return out;
}

/** Per-file identifier occurrence counts — the "references" side of the heuristic. */
function identifierCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of content.matchAll(IDENT_RE)) {
    const t = m[0];
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * Build the file dependency graph: an edge A→B for every symbol defined in B
 * that A references, weighted by reference count (a symbol defined in K files
 * splits its weight K ways so ubiquitous names don't dominate). Reads each file
 * once, bounded by MAX_GRAPH_FILES and MAX_READ_BYTES.
 */
export function buildFileGraph(root: string, files: CodeFile[]): FileGraph {
  const capped =
    files.length > MAX_GRAPH_FILES
      ? [...files].sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel)).slice(0, MAX_GRAPH_FILES)
      : files;

  const defs = new Map<string, string[]>(); // symbol -> files defining it
  const refCounts = new Map<string, Map<string, number>>(); // file -> identifier counts
  const info = new Map<string, FileGraphFileInfo>(); // captured for downstream reuse
  const nodes: string[] = [];
  for (const f of capped) {
    nodes.push(f.rel);
    if (f.size > MAX_READ_BYTES) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.resolve(root, f.rel), "utf8");
    } catch {
      continue;
    }
    // The outline is computed here anyway (for definitions); capture it plus
    // the line count so buildRepoOverview/buildRelevantFiles don't re-read.
    const outline = extractSymbols(f.rel, content);
    info.set(f.rel, { outline, lines: content.split("\n").length });
    for (const name of definedNames(outline)) {
      const arr = defs.get(name);
      if (arr) arr.push(f.rel);
      else defs.set(name, [f.rel]);
    }
    refCounts.set(f.rel, identifierCounts(content));
  }

  const edges = new Map<string, Map<string, number>>();
  let hasEdges = false;
  for (const [from, counts] of refCounts) {
    for (const [name, c] of counts) {
      const definers = defs.get(name);
      if (!definers) continue;
      const others = definers.filter((d) => d !== from);
      if (others.length === 0) continue;
      const w = c / others.length; // distribute a reference across all definers
      let to = edges.get(from);
      if (!to) {
        to = new Map();
        edges.set(from, to);
      }
      for (const d of others) {
        to.set(d, (to.get(d) ?? 0) + w);
        hasEdges = true;
      }
    }
  }
  nodes.sort((a, b) => a.localeCompare(b));
  return { files: nodes, edges, hasEdges, info };
}

/**
 * Memoized graph supplier: build the dependency graph at most ONCE and share
 * it across buildRepoOverview and buildRelevantFiles (the graph companion to
 * the shared `scanRepo` result). A thunk rather than an eager value so the
 * cost is only paid when a builder actually reaches its graph step — each
 * builder has cheap early-outs (small repo, generic task) that must stay free.
 */
export function lazyFileGraph(root: string, scan: RepoScan): () => FileGraph {
  let graph: FileGraph | undefined;
  return () => (graph ??= buildFileGraph(root, scan.files));
}

/**
 * PageRank via deterministic power iteration (damping 0.85, fixed 25 iterations,
 * no randomness). An optional personalization vector biases the teleport toward
 * seed files (their weights need not sum to 1 — normalized here), giving
 * personalized PageRank: rank flows from the task's seed files out along the
 * dependency edges, so files CENTRAL to what the task touches score high even if
 * their names don't match. Returns per-file centrality (larger = more central).
 */
export function computePageRank(graph: FileGraph, personalization?: Map<string, number>): Map<string, number> {
  const { files, edges } = graph;
  const n = files.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;

  // Teleport vector p (normalized to sum 1); uniform when no/empty personalization.
  const p = new Map<string, number>();
  let pSum = 0;
  if (personalization && personalization.size > 0) {
    for (const f of files) {
      const v = Math.max(0, personalization.get(f) ?? 0);
      p.set(f, v);
      pSum += v;
    }
  }
  if (pSum <= 0) {
    for (const f of files) p.set(f, 1);
    pSum = n;
  }
  for (const f of files) p.set(f, p.get(f)! / pSum);

  // Out-weight per node (0 => dangling; its mass is redistributed via teleport).
  const outW = new Map<string, number>();
  for (const [from, to] of edges) {
    let s = 0;
    for (const w of to.values()) s += w;
    outW.set(from, s);
  }

  for (const f of files) rank.set(f, p.get(f)!);
  const d = PAGERANK_DAMPING;
  for (let it = 0; it < PAGERANK_ITERATIONS; it++) {
    let dangling = 0;
    for (const f of files) if ((outW.get(f) ?? 0) === 0) dangling += rank.get(f)!;
    const next = new Map<string, number>();
    for (const f of files) next.set(f, (1 - d) * p.get(f)! + d * dangling * p.get(f)!);
    for (const [from, to] of edges) {
      const ow = outW.get(from)!;
      if (ow === 0) continue;
      const rf = rank.get(from)!;
      for (const [t, w] of to) next.set(t, (next.get(t) ?? 0) + d * rf * (w / ow));
    }
    for (const f of files) rank.set(f, next.get(f)!);
  }
  return rank;
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
 * when the tree can't be read. Reuses a shared scan and a shared (lazy) graph
 * when provided, so a caller that also runs buildRelevantFiles pays for the
 * walk and the graph build once, not twice.
 */
export function buildRepoOverview(
  root: string,
  minFiles = 150,
  scan?: RepoScan,
  graph?: () => FileGraph,
): string | undefined {
  const { files, dirCounts } = scan ?? walk(root, root);
  if (files.length < minFiles) return undefined;
  // Order the Files section by dependency-graph centrality (Aider-style ranked
  // map): most-referenced files first, within the token budget. Falls back to
  // breadth-first when the graph is trivial (no cross-file references).
  const g = graph ? graph() : buildFileGraph(root, files);
  const rank = g.hasEdges ? computePageRank(g) : undefined;
  return formatRepoMap(root, ".", files, dirCounts, 2, 25, rank, g.info);
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
  graph?: () => FileGraph,
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

  // Personalized PageRank over the file dependency graph, biased toward the
  // lexical seeds (the path-matched files, weighted by their score). This is the
  // key win over pure lexical: a file CENTRAL to what the task touches surfaces
  // even when its own name/exports don't match the task terms. Trivial graph
  // (no cross-file references) -> prBoost is 0 and we fall back to pure lexical.
  const g = graph ? graph() : buildFileGraph(root, files);
  let pr: Map<string, number> | undefined;
  let prMax = 0;
  if (g.hasEdges) {
    const personalization = new Map<string, number>();
    for (const { f, score } of pathScored) personalization.set(f.rel, score);
    pr = computePageRank(g, personalization);
    for (const v of pr.values()) if (v > prMax) prMax = v;
  }
  const PR_WEIGHT = 4; // a maximally-central-to-task file earns ~a path-token hit
  const prBoost = (rel: string): number =>
    pr && prMax > 0 ? PR_WEIGHT * ((pr.get(rel) ?? 0) / prMax) : 0;

  // Candidate set: the strongest path-matches, plus the most central files by
  // personalized PageRank (so a central-but-unnamed file gets a chance to clear
  // the floor). Bounded by maxCandidates on each side.
  const byPath = pathScored
    .sort((a, b) => b.score - a.score || a.f.rel.localeCompare(b.f.rel))
    .slice(0, maxCandidates);
  const chosen = new Map<string, { f: CodeFile; pathScore: number }>();
  for (const { f, score } of byPath) chosen.set(f.rel, { f, pathScore: score });
  if (pr && prMax > 0) {
    const fileByRel = new Map(files.map((f) => [f.rel, f] as const));
    const prSorted = [...pr.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxCandidates);
    for (const [rel] of prSorted) {
      if (chosen.has(rel)) continue;
      const f = fileByRel.get(rel);
      if (f) chosen.set(rel, { f, pathScore: 0 });
    }
  }

  // Refine with symbol-outline matches, blending in the (personalized)
  // centrality boost. The graph build already read + outlined every capped
  // file, so most candidates reuse that capture; only files it skipped (over
  // the MAX_GRAPH_FILES cap, unreadable at the time) are read here.
  const refined = [...chosen.values()].map(({ f, pathScore }) => {
    let score = pathScore;
    let outline = "";
    if (f.size <= MAX_READ_BYTES) {
      const cached = g.info?.get(f.rel);
      if (cached) {
        outline = cached.outline;
      } else {
        try {
          const content = fs.readFileSync(path.resolve(root, f.rel), "utf8");
          outline = extractSymbols(f.rel, content);
        } catch {
          // Unreadable -> keep the path-only score (outline stays "").
        }
      }
      const hay = outline.toLowerCase();
      for (const pt of pathTokens) if (hay.includes(pt)) score += 2;
      for (const kw of keywords) if (hay.includes(kw)) score += 1;
    }
    score += prBoost(f.rel);
    return { rel: f.rel, outline, score };
  });

  const top = refined
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, maxFiles);
  if (top.length === 0) return undefined;

  const lines = ["# Task-relevant files (ranked by lexical match + dependency centrality — verify by reading)"];
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
  rank?: Map<string, number>,
  info?: Map<string, FileGraphFileInfo>,
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

  // Files: ranked by dependency centrality when a rank map is supplied
  // (most-referenced first, Aider-style), else breadth-first (shallow first).
  // Both are budgeted, with symbol outlines.
  out.push("", "## Files");
  const sorted = rank
    ? [...files].sort(
        (a, b) => (rank.get(b.rel) ?? 0) - (rank.get(a.rel) ?? 0) || a.depth - b.depth || a.rel.localeCompare(b.rel),
      )
    : [...files].sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  for (const f of sorted.slice(0, maxFiles)) {
    const outline = outlineFor(path.resolve(root, f.rel), f.rel, f.size, info?.get(f.rel));
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
