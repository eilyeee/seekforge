/**
 * Memory storage: Markdown + JSONL files under .seekforge/ (no database).
 *   .seekforge/memory/project.md          approved long-term facts
 *   .seekforge/memory/candidates.jsonl    one MemoryCandidate JSON per line
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readWorkspaceStateFile,
  WorkspaceStateTooLargeError,
  writeWorkspaceStateFileAtomic,
} from "../util/workspace-state.js";
import { withMemoryTransaction } from "./lease.js";

export { withMemoryTransaction } from "./lease.js";

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

export type FactMeta = {
  addedAt: string;
  /** Deliberate use, such as an explicit search_memory retrieval. */
  uses: number;
  /** Number of sessions whose initial brief exposed this fact. */
  exposures?: number;
  /** Number of explicit search_memory retrievals. */
  retrievals?: number;
  lastExposedAt?: string;
  lastUsedAt?: string;
};

const MAX_CANDIDATE_ID_CHARS = 256;
const MAX_CANDIDATE_CONTENT_CHARS = 16 * 1024;
const MAX_SOURCE_SESSION_ID_CHARS = 256;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_FACT_META_KEY_CHARS = MAX_CANDIDATE_CONTENT_CHARS + 64;
export const MAX_MEMORY_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_MEMORY_CANDIDATES_BYTES = 16 * 1024 * 1024;
export const MAX_MEMORY_META_BYTES = 16 * 1024 * 1024;

export class MemoryStateCorruptError extends Error {
  readonly code = "EBADMSG";

  constructor(
    readonly relPath: string,
    detail: string,
  ) {
    super(`memory state is corrupt (${relPath}): ${detail}`);
    this.name = "MemoryStateCorruptError";
  }
}

function readMemoryStateFile(workspace: string, relPath: string, maxBytes: number): string | undefined {
  return readWorkspaceStateFile(workspace, relPath, maxBytes);
}

function writeMemoryStateFile(workspace: string, relPath: string, data: string, maxBytes: number): void {
  if (Buffer.byteLength(data, "utf8") > maxBytes) {
    throw new WorkspaceStateTooLargeError(relPath, maxBytes);
  }
  writeWorkspaceStateFileAtomic(workspace, relPath, data);
}

function isBoundedText(value: unknown, maxChars: number, allowFormatting = false): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars || value.trim() !== value)
    return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 127 || (code <= 31 && !(allowFormatting && (code === 9 || code === 10 || code === 13)))) return false;
  }
  return true;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TIMESTAMP_CHARS) return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  try {
    return new Date(epoch).toISOString() === value;
  } catch {
    return false;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFactMeta(value: unknown): value is FactMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    isIsoTimestamp(meta.addedAt) &&
    isNonNegativeSafeInteger(meta.uses) &&
    (meta.exposures === undefined || isNonNegativeSafeInteger(meta.exposures)) &&
    (meta.retrievals === undefined || isNonNegativeSafeInteger(meta.retrievals)) &&
    (meta.lastExposedAt === undefined || isIsoTimestamp(meta.lastExposedAt)) &&
    (meta.lastUsedAt === undefined || isIsoTimestamp(meta.lastUsedAt))
  );
}

export function factMetaPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "fact-meta.json");
}

function memoryRelPath(name: string): string {
  return path.join(".seekforge", "memory", name);
}

function parseFactMeta(raw: string, strict: boolean): Record<string, FactMeta> {
  const relPath = memoryRelPath("fact-meta.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    if (strict) throw new MemoryStateCorruptError(relPath, "invalid JSON");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    if (strict) throw new MemoryStateCorruptError(relPath, "top-level value must be an object");
    return {};
  }
  const valid: Record<string, FactMeta> = Object.create(null) as Record<string, FactMeta>;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isBoundedText(key, MAX_FACT_META_KEY_CHARS) || !isFactMeta(value)) {
      if (strict) throw new MemoryStateCorruptError(relPath, `invalid entry: ${JSON.stringify(key)}`);
      continue;
    }
    valid[key] = value;
  }
  return valid;
}

/** Metadata keyed by bullet body ("[type] content" — matches brief bullets). */
export function readFactMeta(workspace: string): Record<string, FactMeta> {
  const raw = readMemoryStateFile(workspace, memoryRelPath("fact-meta.json"), MAX_MEMORY_META_BYTES);
  if (!raw) return {};
  return parseFactMeta(raw, false);
}

export function readFactMetaForMutation(workspace: string): Record<string, FactMeta> {
  const raw = readMemoryStateFile(workspace, memoryRelPath("fact-meta.json"), MAX_MEMORY_META_BYTES);
  if (!raw) return {};
  return parseFactMeta(raw, true);
}

function writeFactMeta(workspace: string, meta: Record<string, FactMeta>): void {
  // Best-effort: never break a run on a metadata write failure.
  try {
    writeMemoryStateFile(
      workspace,
      memoryRelPath("fact-meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      MAX_MEMORY_META_BYTES,
    );
  } catch (error) {
    if (error instanceof WorkspaceStateTooLargeError || error instanceof MemoryStateCorruptError) throw error;
    /* ignore */
  }
}

/** First-seen time for a freshly approved/added fact (no-op if already known). */
export function recordFactAdded(workspace: string, bullet: string): void {
  withMemoryTransaction(workspace, () => {
    const key = bullet.replace(/^-\s*/, "").trim();
    const meta = readFactMetaForMutation(workspace);
    if (!meta[key]) {
      meta[key] = { addedAt: new Date().toISOString(), uses: 0 };
      writeFactMeta(workspace, meta);
    }
  });
}

/**
 * Drops fact-meta entries whose bullet body no longer appears in `finalContent`
 * (project.md after a rewrite). Best-effort: never throws. fact-meta is keyed by
 * bullet body ("[type] content"); a compact/merge/hand-edit can orphan entries.
 */
export function reconcileFactMeta(workspace: string, finalContent: string): void {
  try {
    withMemoryTransaction(workspace, () => {
      const meta = readFactMetaForMutation(workspace);
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
    });
  } catch (error) {
    if (error instanceof WorkspaceStateTooLargeError || error instanceof MemoryStateCorruptError) throw error;
    /* best-effort: never break compaction on a metadata reconcile failure */
  }
}

type FactActivity = "exposure" | "use" | "retrieval";

function recordFactActivity(workspace: string, briefText: string, activity: FactActivity): void {
  withMemoryTransaction(workspace, () => {
    const now = new Date().toISOString();
    const meta = readFactMetaForMutation(workspace);
    let changed = false;
    for (const line of briefText.split("\n")) {
      const m = /^-\s*(\[[a-z_]+\].+)$/.exec(line.trim());
      if (!m || m[1] === undefined) continue;
      const key = m[1].trim();
      const entry = meta[key] ?? { addedAt: now, uses: 0 };
      if (activity === "exposure") {
        entry.exposures = Math.min(Number.MAX_SAFE_INTEGER, (entry.exposures ?? 0) + 1);
        entry.lastExposedAt = now;
      } else {
        entry.uses = Math.min(Number.MAX_SAFE_INTEGER, entry.uses + 1);
        entry.lastUsedAt = now;
        if (activity === "retrieval") {
          entry.retrievals = Math.min(Number.MAX_SAFE_INTEGER, (entry.retrievals ?? 0) + 1);
        }
      }
      meta[key] = entry;
      changed = true;
    }
    if (changed) writeFactMeta(workspace, meta);
  });
}

/** Records passive prompt exposure without claiming the fact affected output. */
export function recordFactExposure(workspace: string, briefText: string): void {
  recordFactActivity(workspace, briefText, "exposure");
}

/** Records a deliberate fact use from a caller that can establish relevance. */
export function recordFactUse(workspace: string, briefText: string): void {
  recordFactActivity(workspace, briefText, "use");
}

/** Records facts returned by an explicit search_memory query. */
export function recordFactRetrieval(workspace: string, briefText: string): void {
  recordFactActivity(workspace, briefText, "retrieval");
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
  workspaceRoot: string,
  currentFileRel: string,
  importRootRel: string,
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
    const resolvedRel = path.normalize(path.join(path.dirname(currentFileRel), spec));
    const rel = path.relative(importRootRel, resolvedRel);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    if (depth >= MAX_IMPORT_DEPTH) continue;
    if (visited.has(resolvedRel)) continue; // cycle guard
    let included: string | undefined;
    try {
      included = readMemoryStateFile(workspaceRoot, resolvedRel, MAX_MEMORY_DOCUMENT_BYTES);
    } catch (error) {
      if (error instanceof WorkspaceStateTooLargeError) throw error;
      continue;
    }
    if (included === undefined) continue; // missing → skip silently
    if (budget.remaining <= 0) continue; // size cap reached
    visited.add(resolvedRel);
    const expanded = expandImports(included, workspaceRoot, resolvedRel, importRootRel, depth + 1, visited, budget);
    out.push(expanded);
  }
  return out.join("\n");
}

/** Reads a memory file (if present) and expands any `@import` lines in it. */
function readMemoryFileExpanded(filePath: string, allowedRoot: string): string | undefined {
  try {
    const allowedLogical = path.resolve(allowedRoot);
    const allowedReal = fs.realpathSync(allowedLogical);
    const logicalFile = path.resolve(filePath);
    const fileRel = path.relative(allowedLogical, logicalFile);
    if (fileRel === "" || fileRel === ".." || fileRel.startsWith(`..${path.sep}`) || path.isAbsolute(fileRel)) {
      return undefined;
    }
    const raw = readMemoryStateFile(allowedReal, fileRel, MAX_MEMORY_DOCUMENT_BYTES);
    if (raw === undefined) return undefined;
    const visited = new Set<string>([fileRel]);
    return expandImports(raw, allowedReal, fileRel, path.dirname(fileRel), 0, visited, {
      remaining: MAX_IMPORT_SIZE,
    }).slice(0, MAX_IMPORT_SIZE);
  } catch (error) {
    if (error instanceof WorkspaceStateTooLargeError) throw error;
    return undefined;
  }
}

export function readProjectMemory(workspace: string): string | undefined {
  return readMemoryFileExpanded(projectMemoryPath(workspace), workspace);
}

/**
 * Reads project.md verbatim, WITHOUT expanding `@import` lines. Callers that
 * rewrite the file (edit/remove a bullet, compact) must use this — the expanded
 * form inlines imported files, so writing it back would erase the `@import`
 * directives and duplicate the imported content into the root file.
 */
export function readRawProjectMemory(workspace: string): string | undefined {
  return readMemoryStateFile(workspace, memoryRelPath("project.md"), MAX_MEMORY_DOCUMENT_BYTES);
}

// --- Subdirectory memory cascade (monorepo per-package facts) ----------------
//
// A monorepo package can carry its own `.seekforge/memory/project.md`. The brief
// builder merges those subdir facts in alongside the root project + global ones.
// Discovery is a BOUNDED depth-first scan under the workspace so it never blows
// up on a large repo and stays cheap enough to run on every brief build.

/** Directory names never descended into during the subdir scan. */
const SUBDIR_SCAN_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", "target", "out", "coverage"]);
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
      const content = readMemoryFileExpanded(memFile, workspace);
      if (content !== undefined && content.trim().length > 0) {
        results.push({ relDir: path.relative(workspace, childDir), content });
        if (results.length >= SUBDIR_SCAN_MAX_FILES) return;
      }
      walk(childDir, depth + 1);
    }
  };
  try {
    walk(workspace, 1);
  } catch (error) {
    if (error instanceof WorkspaceStateTooLargeError) throw error;
    // Best-effort: memory is non-essential; never throw out of discovery.
  }
  return results;
}

/**
 * Reads the global (cross-project) memory file under the SeekForge home, with
 * `@import` lines expanded. Returns undefined when the file is absent.
 */
export function readGlobalMemory(): string | undefined {
  return readMemoryFileExpanded(globalMemoryPath(), seekforgeHome());
}

function isCandidateRecord(value: unknown): value is MemoryCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    isBoundedText(c.id, MAX_CANDIDATE_ID_CHARS) &&
    isBoundedText(c.content, MAX_CANDIDATE_CONTENT_CHARS, true) &&
    MEMORY_CANDIDATE_TYPES.includes(c.type as MemoryCandidateType) &&
    typeof c.confidence === "number" &&
    Number.isFinite(c.confidence) &&
    c.confidence >= 0 &&
    c.confidence <= 1 &&
    isBoundedText(c.sourceSessionId, MAX_SOURCE_SESSION_ID_CHARS) &&
    isIsoTimestamp(c.createdAt) &&
    (c.status === "pending" || c.status === "approved" || c.status === "rejected")
  );
}

function assertCandidateRecord(value: unknown): asserts value is MemoryCandidate {
  if (!isCandidateRecord(value)) throw new Error("invalid memory candidate");
}

function parseCandidates(raw: string, strict: boolean): MemoryCandidate[] {
  const relPath = memoryRelPath("candidates.jsonl");
  const candidates: MemoryCandidate[] = [];
  let lineNumber = 0;
  for (const line of raw.split("\n")) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      if (strict) throw new MemoryStateCorruptError(relPath, `invalid JSON on line ${lineNumber}`);
      continue;
    }
    if (!isCandidateRecord(parsed)) {
      if (strict) throw new MemoryStateCorruptError(relPath, `invalid candidate on line ${lineNumber}`);
      continue;
    }
    candidates.push(parsed);
  }
  return candidates;
}

/** Candidates in file (append) order; corrupt lines are skipped. */
export function readCandidates(workspace: string): MemoryCandidate[] {
  const raw = readMemoryStateFile(workspace, memoryRelPath("candidates.jsonl"), MAX_MEMORY_CANDIDATES_BYTES);
  if (!raw) return [];
  return parseCandidates(raw, false);
}

export function readCandidatesForMutation(workspace: string): MemoryCandidate[] {
  const raw = readMemoryStateFile(workspace, memoryRelPath("candidates.jsonl"), MAX_MEMORY_CANDIDATES_BYTES);
  if (!raw) return [];
  return parseCandidates(raw, true);
}

export function listMemoryCandidates(workspace: string): MemoryCandidate[] {
  // File order is append (chronological) order; newest first means reversed.
  return readCandidates(workspace).reverse();
}

export function appendCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  if (candidates.length === 0) return;
  withMemoryTransaction(workspace, () => {
    for (const candidate of candidates) assertCandidateRecord(candidate);
    const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
    const existing =
      readMemoryStateFile(workspace, memoryRelPath("candidates.jsonl"), MAX_MEMORY_CANDIDATES_BYTES) ?? "";
    writeMemoryStateFile(
      workspace,
      memoryRelPath("candidates.jsonl"),
      `${existing}${lines}`,
      MAX_MEMORY_CANDIDATES_BYTES,
    );
  });
}

/** Module-internal (used by direct.ts); not part of the public barrel. */
export function writeCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  withMemoryTransaction(workspace, () => {
    for (const candidate of candidates) assertCandidateRecord(candidate);
    const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
    writeMemoryStateFile(workspace, memoryRelPath("candidates.jsonl"), lines, MAX_MEMORY_CANDIDATES_BYTES);
  });
}

export function formatFactBullet(candidate: Pick<MemoryCandidate, "type" | "content">): string {
  // A fact bullet MUST stay on one line: project.md is line-oriented, and the
  // append dedupe (and memory brief) compare whole lines. Embedded newlines
  // would orphan the tail onto its own line and make the exact-line dedupe never
  // match, re-appending the same fact on every write.
  const line = candidate.content.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return `- [${candidate.type}] ${line}`;
}

/** Appends a fact bullet to project.md, creating it with a header if needed. */
export function appendProjectFact(workspace: string, candidate: MemoryCandidate): void {
  withMemoryTransaction(workspace, () => {
    assertCandidateRecord(candidate);
    const bullet = formatFactBullet(candidate);
    const existing = readMemoryStateFile(workspace, memoryRelPath("project.md"), MAX_MEMORY_DOCUMENT_BYTES);
    if (existing === undefined) {
      writeMemoryStateFile(
        workspace,
        memoryRelPath("project.md"),
        `# Project Memory\n${bullet}\n`,
        MAX_MEMORY_DOCUMENT_BYTES,
      );
      recordFactAdded(workspace, bullet);
      return;
    }
    // Dedupe: skip when an identical content line already exists.
    if (existing.split("\n").some((line) => line.trim() === bullet)) return;
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeMemoryStateFile(
      workspace,
      memoryRelPath("project.md"),
      `${existing}${sep}${bullet}\n`,
      MAX_MEMORY_DOCUMENT_BYTES,
    );
    recordFactAdded(workspace, bullet);
  });
}

function setCandidateStatus(workspace: string, id: string, status: MemoryCandidate["status"]): MemoryCandidate {
  return withMemoryTransaction(workspace, () => {
    const candidates = readCandidatesForMutation(workspace);
    const target = candidates.find((c) => c.id === id);
    if (!target) {
      throw new Error(`candidate not found: ${id}`);
    }
    target.status = status;
    writeCandidates(workspace, candidates);
    return target;
  });
}

/** Appends the fact to project.md and marks the candidate approved. */
/**
 * Appends a fact bullet to the USER-level memory (~/.seekforge/memory/project.md,
 * SEEKFORGE_HOME-overridable) — facts that apply across all projects. No
 * fact-meta tracking (that sidecar is project-scoped).
 */
export function appendGlobalFact(candidate: MemoryCandidate): void {
  const home = seekforgeHome();
  withMemoryTransaction(home, () => {
    assertCandidateRecord(candidate);
    const bullet = formatFactBullet(candidate);
    const existing = readMemoryStateFile(home, memoryRelPath("project.md"), MAX_MEMORY_DOCUMENT_BYTES);
    if (existing === undefined) {
      writeMemoryStateFile(
        home,
        memoryRelPath("project.md"),
        `# Global Memory\n${bullet}\n`,
        MAX_MEMORY_DOCUMENT_BYTES,
      );
      return;
    }
    if (existing.split("\n").some((line) => line.trim() === bullet)) return;
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeMemoryStateFile(home, memoryRelPath("project.md"), `${existing}${sep}${bullet}\n`, MAX_MEMORY_DOCUMENT_BYTES);
  });
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
  return withMemoryTransaction(workspace, () => {
    const candidates = readCandidatesForMutation(workspace);
    const target = candidates.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`candidate not found: ${id}`);
    const approved = { ...target, status: "approved" as const };
    if (scope === "user") appendGlobalFact(approved);
    else appendProjectFact(workspace, approved);
    target.status = "approved";
    writeCandidates(workspace, candidates);
    return approved;
  });
}

export function rejectMemoryCandidate(workspace: string, id: string): MemoryCandidate {
  return withMemoryTransaction(workspace, () => setCandidateStatus(workspace, id, "rejected"));
}
