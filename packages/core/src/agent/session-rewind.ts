/**
 * Session checkpoints, rewind/fork, and their JSONL store — split out of
 * trace.ts, which keeps the append-fd machinery, session meta, and message
 * loading. This module layers the "undo what a session did to the worktree"
 * operations on top of trace's session-file primitives.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { resolveForWrite } from "../tools/sandbox.js";
import type { SessionLease } from "./session-lease.js";
import {
  appendLineSync,
  newSessionId,
  readSessionMeta,
  readSessionText,
  sessionFile,
  withSessionMutation,
  writeSessionMeta,
  writeSessionText,
} from "./trace.js";

export type CheckpointEntry = {
  ts: string;
  /** Workspace-relative path of the file. */
  path: string;
  /** Full content BEFORE the run's first write, or null if the file did not exist. */
  before: string | null;
  /**
   * 0-based user-turn index of the run that recorded the entry (aligned with
   * truncateSessionAtUserTurn's all-user-messages indexing). Absent in files
   * written before per-turn checkpointing; readers treat missing as 0.
   */
  turn?: number;
};

function checkpointsFile(workspace: string, sessionId: string): string {
  return sessionFile(workspace, sessionId, "checkpoints.jsonl");
}

/** Appends one pre-write snapshot to <session>/checkpoints.jsonl. */
export function appendCheckpoint(workspace: string, sessionId: string, entry: CheckpointEntry): void {
  const file = sessionFile(workspace, sessionId, "checkpoints.jsonl", true);
  appendLineSync(file, `${JSON.stringify(entry)}\n`);
}

/** Reads the longest valid checkpoint prefix in recorded order. */
export function readCheckpoints(workspace: string, sessionId: string): CheckpointEntry[] {
  const file = checkpointsFile(workspace, sessionId);
  if (!existsSync(file)) return [];
  const entries: CheckpointEntry[] = [];
  for (const line of readSessionText(workspace, sessionId, "checkpoints.jsonl").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CheckpointEntry>;
      if (typeof parsed.path !== "string" || parsed.path === "") break;
      if (parsed.before !== null && typeof parsed.before !== "string") break;
      entries.push({
        ts: typeof parsed.ts === "string" ? parsed.ts : "",
        path: parsed.path,
        before: parsed.before,
        // Legacy entries predate per-turn checkpointing: treat them as turn 0.
        ...(typeof parsed.turn === "number" && Number.isInteger(parsed.turn) && parsed.turn >= 0
          ? { turn: parsed.turn }
          : {}),
      });
    } catch {
      // Append-only logs recover only through the first damaged record.
      break;
    }
  }
  return entries;
}

export type RewindResult = {
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: string }>;
};

/** Removes now-empty parent directories of a deleted file, up to (excluding) the workspace root. */
function pruneEmptyDirs(dir: string, root: string): void {
  let current = dir;
  while (current.startsWith(root + sep)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return; // best-effort
    }
    current = dirname(current);
  }
}

/**
 * Applies one checkpoint entry per path: before === null deletes the file
 * (the run created it), otherwise the snapshotted content is written back.
 * Entries whose path resolves outside the workspace root are refused (the
 * checkpoint file may have been tampered with). Shared by rewindSession and
 * rewindSessionToTurn, which differ only in WHICH entry per path they pick.
 */
function applyCheckpoints(
  workspace: string,
  entries: Iterable<CheckpointEntry>,
  opts: { dryRun?: boolean },
): RewindResult {
  const result: RewindResult = { restored: [], deleted: [], skipped: [] };
  const wsRoot = resolveForWrite(workspace, ".");

  for (const entry of entries) {
    try {
      const target = resolveForWrite(workspace, entry.path);
      if (target === wsRoot) {
        result.skipped.push({ path: entry.path, reason: "path resolves to the workspace root" });
        continue;
      }
      if (entry.before === null) {
        if (!existsSync(target)) {
          result.skipped.push({ path: entry.path, reason: "already absent" });
          continue;
        }
        if (!opts.dryRun) {
          rmSync(target);
          pruneEmptyDirs(dirname(target), wsRoot);
        }
        result.deleted.push(entry.path);
      } else {
        if (!opts.dryRun) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, entry.before, "utf8");
        }
        result.restored.push(entry.path);
      }
    } catch (err) {
      const reason =
        (err as { code?: unknown }).code === "outside_workspace"
          ? "path escapes the workspace"
          : err instanceof Error
            ? err.message
            : String(err);
      result.skipped.push({ path: entry.path, reason });
    }
  }
  return result;
}

/**
 * Undoes all file changes a session made by applying the FIRST recorded
 * checkpoint per path. With per-turn entries that is still the oldest
 * pre-content of each file, i.e. its state before the session touched it.
 */
export function rewindSession(
  workspace: string,
  sessionId: string,
  opts: { dryRun?: boolean } = {},
  lease?: SessionLease,
): RewindResult {
  return withSessionMutation(workspace, sessionId, lease, () => {
    const firstPerPath = new Map<string, CheckpointEntry>();
    for (const entry of readCheckpoints(workspace, sessionId)) {
      if (!firstPerPath.has(entry.path)) firstPerPath.set(entry.path, entry);
    }
    return applyCheckpoints(workspace, firstPerPath.values(), opts);
  });
}

/**
 * Undoes the file changes made by user turns >= `turnIndex` of a session:
 * for each path, restores the EARLIEST checkpoint entry recorded with
 * `turn >= turnIndex` (the file's state just before that turn first wrote
 * it). Paths only touched in earlier turns are left alone. Entries without
 * a `turn` (written before per-turn checkpointing) count as turn 0.
 * Companion to truncateSessionAtUserTurn, which shares the same 0-based
 * all-user-messages turn indexing.
 */
export function rewindSessionToTurn(
  workspace: string,
  sessionId: string,
  turnIndex: number,
  opts: { dryRun?: boolean } = {},
  lease?: SessionLease,
): RewindResult {
  return withSessionMutation(workspace, sessionId, lease, () => {
    const earliestPerPath = new Map<string, CheckpointEntry>();
    for (const entry of readCheckpoints(workspace, sessionId)) {
      if ((entry.turn ?? 0) < turnIndex) continue;
      if (!earliestPerPath.has(entry.path)) earliestPerPath.set(entry.path, entry);
    }
    return applyCheckpoints(workspace, earliestPerPath.values(), opts);
  });
}

/**
 * Forks a stored session into a fresh one: copies messages.jsonl (and
 * checkpoints.jsonl when present) into a new session directory under a new
 * id, and writes meta derived from the original ("(fork) " task prefix,
 * status "completed", fresh timestamps) so the fork is immediately resumable
 * without touching the original. Returns the new session id, or null when
 * the source session (meta or messages) is missing.
 */
export function forkSession(workspace: string, sessionId: string, lease?: SessionLease): string | null {
  return withSessionMutation(workspace, sessionId, lease, () => {
    const srcMessages = sessionFile(workspace, sessionId, "messages.jsonl");
    const meta = readSessionMeta(workspace, sessionId);
    if (!meta || !existsSync(srcMessages)) return null;

    const id = newSessionId();
    writeSessionText(workspace, id, "messages.jsonl", readSessionText(workspace, sessionId, "messages.jsonl"));
    const srcCheckpoints = sessionFile(workspace, sessionId, "checkpoints.jsonl");
    if (existsSync(srcCheckpoints)) {
      writeSessionText(workspace, id, "checkpoints.jsonl", readSessionText(workspace, sessionId, "checkpoints.jsonl"));
    }

    const now = new Date().toISOString();
    writeSessionMeta(workspace, {
      ...meta,
      id,
      task: `(fork) ${meta.task}`,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  });
}
