/**
 * Memory storage: Markdown + JSONL files under .seekforge/ (no database).
 *   .seekforge/memory/project.md          approved long-term facts
 *   .seekforge/memory/candidates.jsonl    one MemoryCandidate JSON per line
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type MemoryCandidateType = "command" | "path" | "convention" | "tech" | "task_pattern";

export const MEMORY_CANDIDATE_TYPES: readonly MemoryCandidateType[] = [
  "command",
  "path",
  "convention",
  "tech",
  "task_pattern",
];

export type MemoryCandidate = {
  id: string;
  content: string;
  type: MemoryCandidateType;
  /** 0..1, model-assessed. */
  confidence: number;
  sourceSessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
};

export function projectMemoryPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "project.md");
}

/**
 * Root for SeekForge's global (cross-project) state. Mirrors where global config
 * lives (~/.seekforge). Overridable via SEEKFORGE_HOME so tests stay
 * deterministic and never touch the developer's real home directory.
 */
export function seekforgeHome(): string {
  const override = process.env.SEEKFORGE_HOME;
  return override && override.length > 0 ? override : os.homedir();
}

/** Path to the global (cross-project) memory file under the SeekForge home. */
export function globalMemoryPath(): string {
  return path.join(seekforgeHome(), ".seekforge", "memory", "project.md");
}

export function candidatesPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "candidates.jsonl");
}

export function sessionSummaryPath(workspace: string, sessionId: string): string {
  return path.join(workspace, ".seekforge", "sessions", sessionId, "summary.md");
}

// --- Per-fact lifecycle metadata (sidecar; project.md stays clean) ----------

export type FactMeta = { addedAt: string; uses: number; lastUsedAt?: string };

export function factMetaPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "fact-meta.json");
}

/** Metadata keyed by bullet body ("[type] content" — matches brief bullets). */
export function readFactMeta(workspace: string): Record<string, FactMeta> {
  const raw = readFileIfExists(factMetaPath(workspace));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, FactMeta>)
      : {};
  } catch {
    return {};
  }
}

function writeFactMeta(workspace: string, meta: Record<string, FactMeta>): void {
  // Best-effort: never break a run on a metadata write failure.
  try {
    const file = factMetaPath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/** First-seen time for a freshly approved/added fact (no-op if already known). */
export function recordFactAdded(workspace: string, bullet: string): void {
  const key = bullet.replace(/^-\s*/, "").trim();
  const meta = readFactMeta(workspace);
  if (!meta[key]) {
    meta[key] = { addedAt: new Date().toISOString(), uses: 0 };
    writeFactMeta(workspace, meta);
  }
}

/**
 * Drops fact-meta entries whose bullet body no longer appears in `finalContent`
 * (project.md after a rewrite). Best-effort: never throws. fact-meta is keyed by
 * bullet body ("[type] content"); a compact/merge/hand-edit can orphan entries.
 */
export function reconcileFactMeta(workspace: string, finalContent: string): void {
  try {
    const meta = readFactMeta(workspace);
    const keys = Object.keys(meta);
    if (keys.length === 0) return;
    const live = new Set<string>();
    for (const line of finalContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) continue;
      live.add(trimmed.replace(/^-\s*/, ""));
    }
    let changed = false;
    for (const key of keys) {
      if (!live.has(key)) {
        delete meta[key];
        changed = true;
      }
    }
    if (changed) writeFactMeta(workspace, meta);
  } catch {
    /* best-effort: never break compaction on a metadata reconcile failure */
  }
}

/** Bumps usage for every fact bullet present in an injected brief. */
export function recordFactUse(workspace: string, briefText: string): void {
  const now = new Date().toISOString();
  const meta = readFactMeta(workspace);
  let changed = false;
  for (const line of briefText.split("\n")) {
    const m = /^-\s*(\[[a-z_]+\].+)$/.exec(line.trim());
    if (!m || m[1] === undefined) continue;
    const key = m[1].trim();
    // A hand-edited/corrupt fact-meta.json may hold a non-object (or a missing
    // numeric `uses`) at this key; coerce rather than throw mid-run.
    const prev = meta[key];
    const entry: FactMeta =
      prev !== null && typeof prev === "object" ? prev : { addedAt: now, uses: 0 };
    entry.uses = (typeof entry.uses === "number" && Number.isFinite(entry.uses) ? entry.uses : 0) + 1;
    entry.lastUsedAt = now;
    meta[key] = entry;
    changed = true;
  }
  if (changed) writeFactMeta(workspace, meta);
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

// --- @import composition ----------------------------------------------------
//
// Lines of the form `@<relative-path>` in a memory file are expanded by inlining
// the referenced file's text in place, so teams can split/share memory across
// files. Rules (all best-effort — never throw):
//   - the path is resolved relative to the including file's directory,
//   - absolute paths and `..` traversal outside that directory are refused,
//   - missing files are skipped silently,
//   - cycles are broken (visited set) and depth + total size are capped.

/** Max nesting depth of @import expansion. */
const MAX_IMPORT_DEPTH = 3;
/** Max total expanded size (chars); imports past this are ignored. */
const MAX_IMPORT_SIZE = 64 * 1024;
/** Matches a whole line that is just `@<path>` (optional surrounding spaces). */
const IMPORT_LINE = /^\s*@(\S+)\s*$/;

/**
 * Expands `@import` lines in `text`. `dir` is the directory the file lives in
 * (the base for relative imports). `visited` tracks already-included absolute
 * paths to break cycles. Returns text with imports inlined.
 */
function expandImports(
  text: string,
  dir: string,
  depth: number,
  visited: Set<string>,
  budget: { remaining: number },
): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = IMPORT_LINE.exec(line);
    if (!m || m[1] === undefined) {
      out.push(line);
      budget.remaining -= line.length + 1;
      continue;
    }
    // Refuse absolute paths and traversal that escapes the base directory.
    const spec = m[1];
    if (path.isAbsolute(spec)) continue;
    const resolved = path.resolve(dir, spec);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (depth >= MAX_IMPORT_DEPTH) continue;
    if (visited.has(resolved)) continue; // cycle guard
    const included = readFileIfExists(resolved);
    if (included === undefined) continue; // missing → skip silently
    if (budget.remaining <= 0) continue; // size cap reached
    visited.add(resolved);
    const expanded = expandImports(included, path.dirname(resolved), depth + 1, visited, budget);
    out.push(expanded);
  }
  return out.join("\n");
}

/** Reads a memory file (if present) and expands any `@import` lines in it. */
function readMemoryFileExpanded(filePath: string): string | undefined {
  const raw = readFileIfExists(filePath);
  if (raw === undefined) return undefined;
  try {
    const visited = new Set<string>([path.resolve(filePath)]);
    return expandImports(raw, path.dirname(filePath), 0, visited, {
      remaining: MAX_IMPORT_SIZE,
    });
  } catch {
    // Best-effort: fall back to the raw (unexpanded) content on any failure.
    return raw;
  }
}

export function readProjectMemory(workspace: string): string | undefined {
  return readMemoryFileExpanded(projectMemoryPath(workspace));
}

/**
 * Reads project.md verbatim, WITHOUT expanding `@import` lines. Callers that
 * rewrite the file (edit/remove a bullet, compact) must use this — the expanded
 * form inlines imported files, so writing it back would erase the `@import`
 * directives and duplicate the imported content into the root file.
 */
export function readRawProjectMemory(workspace: string): string | undefined {
  return readFileIfExists(projectMemoryPath(workspace));
}

// --- Subdirectory memory cascade (monorepo per-package facts) ----------------
//
// A monorepo package can carry its own `.seekforge/memory/project.md`. The brief
// builder merges those subdir facts in alongside the root project + global ones.
// Discovery is a BOUNDED depth-first scan under the workspace so it never blows
// up on a large repo and stays cheap enough to run on every brief build.

/** Directory names never descended into during the subdir scan. */
const SUBDIR_SCAN_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
]);
/** Max directory depth (below the workspace root) the scan descends. */
const SUBDIR_SCAN_MAX_DEPTH = 4;
/** Max number of subdir memory files collected (hard stop). */
const SUBDIR_SCAN_MAX_FILES = 25;

/** A subdir memory file plus the workspace-relative dir it was found in. */
export type SubdirMemory = { relDir: string; content: string };

/**
 * Discovers `.seekforge/memory/project.md` files in SUBDIRECTORIES of `workspace`
 * (the root's own file is NOT included — readProjectMemory handles that). The
 * walk is bounded by depth, total-file count, and an exclude list, and tolerates
 * any fs error (best-effort: a failed readdir/stat just prunes that branch).
 *
 * Each result's `@import` lines are expanded the same way as the root/global
 * files. `relDir` is the package directory relative to the workspace (used to
 * tag bullets for relevance + precedence).
 */
export function readSubdirMemories(workspace: string): SubdirMemory[] {
  const results: SubdirMemory[] = [];
  const walk = (dir: string, depth: number): void => {
    if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
    if (depth > SUBDIR_SCAN_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission/IO error: skip this branch silently
    }
    for (const entry of entries) {
      if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (SUBDIR_SCAN_EXCLUDE.has(name)) continue;
      const childDir = path.join(dir, name);
      if (name === ".seekforge") {
        // Never recurse INTO a .seekforge dir: the root's project.md is already
        // the root file, and sessions/worktrees underneath are heavy + irrelevant.
        // A package's own .seekforge/memory/project.md is found via the
        // projectMemoryPath(childDir) check below when childDir is the package dir.
        continue;
      }
      // Collect this package's own memory file, if present.
      const memFile = projectMemoryPath(childDir);
      const content = readMemoryFileExpanded(memFile);
      if (content !== undefined && content.trim().length > 0) {
        results.push({ relDir: path.relative(workspace, childDir), content });
        if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
      }
      walk(childDir, depth + 1);
    }
  };
  try {
    walk(workspace, 1);
  } catch {
    // Best-effort: memory is non-essential; never throw out of discovery.
  }
  return results;
}

/**
 * Reads the global (cross-project) memory file under the SeekForge home, with
 * `@import` lines expanded. Returns undefined when the file is absent.
 */
export function readGlobalMemory(): string | undefined {
  return readMemoryFileExpanded(globalMemoryPath());
}

function isCandidateRecord(value: unknown): value is MemoryCandidate {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.content === "string" &&
    MEMORY_CANDIDATE_TYPES.includes(c.type as MemoryCandidateType) &&
    typeof c.confidence === "number" &&
    typeof c.sourceSessionId === "string" &&
    typeof c.createdAt === "string" &&
    (c.status === "pending" || c.status === "approved" || c.status === "rejected")
  );
}

/** Candidates in file (append) order; corrupt lines are skipped. */
export function readCandidates(workspace: string): MemoryCandidate[] {
  const raw = readFileIfExists(candidatesPath(workspace));
  if (!raw) return [];
  const candidates: MemoryCandidate[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isCandidateRecord(parsed)) candidates.push(parsed);
    } catch {
      // Corrupt line: tolerate and skip.
    }
  }
  return candidates;
}

export function listMemoryCandidates(workspace: string): MemoryCandidate[] {
  // File order is append (chronological) order; newest first means reversed.
  return readCandidates(workspace).reverse();
}

export function appendCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  if (candidates.length === 0) return;
  const file = candidatesPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
  fs.appendFileSync(file, lines, "utf8");
}

/** Module-internal (used by direct.ts); not part of the public barrel. */
export function writeCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  const file = candidatesPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
  fs.writeFileSync(file, lines, "utf8");
}

export function formatFactBullet(candidate: Pick<MemoryCandidate, "type" | "content">): string {
  return `- [${candidate.type}] ${candidate.content}`;
}

/** Appends a fact bullet to project.md, creating it with a header if needed. */
export function appendProjectFact(workspace: string, candidate: MemoryCandidate): void {
  const file = projectMemoryPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bullet = formatFactBullet(candidate);
  const existing = readFileIfExists(file);
  if (existing === undefined) {
    fs.writeFileSync(file, `# Project Memory\n${bullet}\n`, "utf8");
    recordFactAdded(workspace, bullet);
    return;
  }
  // Dedupe: skip when an identical content line already exists.
  if (existing.split("\n").some((line) => line.trim() === bullet)) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${sep}${bullet}\n`, "utf8");
  recordFactAdded(workspace, bullet);
}

function setCandidateStatus(
  workspace: string,
  id: string,
  status: MemoryCandidate["status"],
): MemoryCandidate {
  const candidates = readCandidates(workspace);
  const target = candidates.find((c) => c.id === id);
  if (!target) {
    throw new Error(`candidate not found: ${id}`);
  }
  target.status = status;
  writeCandidates(workspace, candidates);
  return target;
}

/** Appends the fact to project.md and marks the candidate approved. */
/**
 * Appends a fact bullet to the USER-level memory (~/.seekforge/memory/project.md,
 * SEEKFORGE_HOME-overridable) — facts that apply across all projects. No
 * fact-meta tracking (that sidecar is project-scoped).
 */
export function appendGlobalFact(candidate: MemoryCandidate): void {
  const file = globalMemoryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bullet = formatFactBullet(candidate);
  const existing = readFileIfExists(file);
  if (existing === undefined) {
    fs.writeFileSync(file, `# Global Memory\n${bullet}\n`, "utf8");
    return;
  }
  if (existing.split("\n").some((line) => line.trim() === bullet)) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${sep}${bullet}\n`, "utf8");
}

/**
 * Approves a candidate into long-term memory. `scope:"user"` promotes it to the
 * user-level file (applies to all projects); default "project" writes to the
 * project's project.md. The candidate is marked approved in the project store
 * either way.
 */
export function approveMemoryCandidate(
  workspace: string,
  id: string,
  scope: "project" | "user" = "project",
): MemoryCandidate {
  const candidate = setCandidateStatus(workspace, id, "approved");
  if (scope === "user") appendGlobalFact(candidate);
  else appendProjectFact(workspace, candidate);
  return candidate;
}

export function rejectMemoryCandidate(workspace: string, id: string): MemoryCandidate {
  return setCandidateStatus(workspace, id, "rejected");
}
