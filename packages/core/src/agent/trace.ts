import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentEvent, ChatMessage, SessionStatus, TokenUsage } from "@seekforge/shared";
import { compactMessages, estimateMessagesTokens } from "./context.js";

export type SessionTrace = {
  dir: string;
  message: (m: ChatMessage) => void;
  toolCall: (entry: Record<string, unknown>) => void;
  event: (e: AgentEvent) => void;
  summary: (markdown: string) => void;
};

/** JSONL session trace under <workspace>/.seekforge/sessions/<id>/. */
export function createSessionTrace(workspace: string, sessionId: string): SessionTrace {
  const dir = join(workspace, ".seekforge", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });

  const append = (file: string, value: unknown) => {
    appendFileSync(join(dir, file), `${JSON.stringify({ ts: new Date().toISOString(), ...(value as object) })}\n`);
  };

  return {
    dir,
    message: (m) => append("messages.jsonl", m),
    toolCall: (entry) => append("tool-calls.jsonl", entry),
    event: (e) => append("events.jsonl", e),
    summary: (markdown) => writeFileSync(join(dir, "summary.md"), markdown),
  };
}

export type SessionMeta = {
  id: string;
  task: string;
  mode: "ask" | "edit";
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  usage?: TokenUsage;
  /** Set on sessions spawned by dispatch_agent: the dispatching agent id. */
  parentAgentId?: string;
};

function sessionsRoot(workspace: string): string {
  return join(workspace, ".seekforge", "sessions");
}

export function writeSessionMeta(workspace: string, meta: SessionMeta): void {
  const dir = join(sessionsRoot(workspace), meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

export function readSessionMeta(workspace: string, sessionId: string): SessionMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(sessionsRoot(workspace), sessionId, "session.json"), "utf8")) as SessionMeta;
  } catch {
    return undefined;
  }
}

export type ListSessionsOptions = {
  /** Include subagent (dispatched) sessions. Default: false (top-level only). */
  includeSubagents?: boolean;
};

/** Sessions of a workspace, newest first. Subagent sessions hidden by default. */
export function listSessions(workspace: string, opts: ListSessionsOptions = {}): SessionMeta[] {
  const root = sessionsRoot(workspace);
  if (!existsSync(root)) return [];
  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readSessionMeta(workspace, entry.name);
    if (!meta) continue;
    if (meta.parentAgentId && !opts.includeSubagents) continue;
    metas.push(meta);
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type PruneSessionsOptions = {
  /** Delete sessions older than this many days (by createdAt). */
  olderThanDays?: number;
  /** Keep at most this many most-recent top-level sessions. */
  keepLast?: number;
  /** Only count/report what would be deleted, don't delete. */
  dryRun?: boolean;
};

export type PruneResult = { removed: string[]; kept: number };

/**
 * Removes old session directories. A session is pruned when it is older than
 * `olderThanDays` OR falls outside the `keepLast` most-recent ones. Subagent
 * sessions are pruned together with (and counted under) their own age, so the
 * whole .seekforge/sessions tree stays bounded. Running sessions are skipped.
 */
export function pruneSessions(workspace: string, opts: PruneSessionsOptions = {}): PruneResult {
  const root = sessionsRoot(workspace);
  if (!existsSync(root)) return { removed: [], kept: 0 };

  const all = listSessions(workspace, { includeSubagents: true });
  const cutoff =
    opts.olderThanDays !== undefined ? Date.now() - opts.olderThanDays * 86_400_000 : undefined;

  // keepLast applies to top-level sessions only (subagent runs ride along).
  const topLevel = all.filter((m) => !m.parentAgentId);
  const keptByRecency = new Set(
    opts.keepLast !== undefined ? topLevel.slice(0, opts.keepLast).map((m) => m.id) : topLevel.map((m) => m.id),
  );

  const removed: string[] = [];
  for (const meta of all) {
    if (meta.status === "running") continue;
    const tooOld = cutoff !== undefined && new Date(meta.createdAt).getTime() < cutoff;
    const overflow = !meta.parentAgentId && !keptByRecency.has(meta.id);
    if (!tooOld && !overflow) continue;
    removed.push(meta.id);
    if (!opts.dryRun) rmSync(join(root, meta.id), { recursive: true, force: true });
  }
  return { removed, kept: all.length - removed.length };
}

/** Replays messages.jsonl back into ChatMessage[] for session resume. */
export function loadSessionMessages(workspace: string, sessionId: string): ChatMessage[] {
  const file = join(sessionsRoot(workspace), sessionId, "messages.jsonl");
  const messages: ChatMessage[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { ts: _ts, ...message } = JSON.parse(line) as ChatMessage & { ts?: string };
    messages.push(message);
  }
  return messages;
}

export type ManualCompactionResult = {
  droppedTurns: number;
  beforeTokens: number;
  afterTokens: number;
};

/**
 * On-demand compaction of a stored session (the TUI/REPL /compact command):
 * folds the middle of messages.jsonl into a digest NOW, regardless of the
 * context budget, and rewrites the file. The next resume replays the
 * compacted history. Returns null when the session is too short to compact
 * or has no messages file.
 */
export function compactSessionNow(workspace: string, sessionId: string): ManualCompactionResult | null {
  let messages: ChatMessage[];
  try {
    messages = loadSessionMessages(workspace, sessionId);
  } catch {
    return null;
  }
  const beforeTokens = estimateMessagesTokens(messages);
  // Budget 0 forces compaction whenever the message shape allows it.
  const compacted = compactMessages(messages, 0);
  if (!compacted) return null;

  rewriteSessionMessages(workspace, sessionId, compacted.messages);
  return {
    droppedTurns: compacted.droppedTurns,
    beforeTokens,
    afterTokens: estimateMessagesTokens(compacted.messages),
  };
}

/**
 * Replaces a session's messages.jsonl wholesale (manual compaction flows
 * that build the new history elsewhere, e.g. LLM-summarized /compact).
 */
export function rewriteSessionMessages(workspace: string, sessionId: string, messages: ChatMessage[]): void {
  const file = join(sessionsRoot(workspace), sessionId, "messages.jsonl");
  const ts = new Date().toISOString();
  const lines = messages.map((m) => JSON.stringify({ ts, ...m }));
  writeFileSync(file, `${lines.join("\n")}\n`);
}

export type TruncateResult = { removedMessages: number; keptMessages: number };

/**
 * Rewinds a stored session's conversation to just BEFORE one of its user
 * turns: counts ALL role:"user" messages in messages.jsonl in file order as
 * turns 0..N-1, keeps every message before the `turnIndex`-th one and drops
 * that message plus everything after, then rewrites the file. The next
 * resume replays the truncated history.
 *
 * turnIndex 0 is refused (truncating before the original task message would
 * empty the conversation): returns null. Also returns null when turnIndex is
 * out of range or the messages file is missing/unreadable. File changes made
 * by the dropped turns are NOT touched — use rewindSession for that.
 */
export function truncateSessionAtUserTurn(
  workspace: string,
  sessionId: string,
  turnIndex: number,
): TruncateResult | null {
  if (turnIndex <= 0 || !Number.isInteger(turnIndex)) return null;

  let messages: ChatMessage[];
  try {
    messages = loadSessionMessages(workspace, sessionId);
  } catch {
    return null;
  }

  let userTurn = -1;
  let cutAt = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role !== "user") continue;
    userTurn += 1;
    if (userTurn === turnIndex) {
      cutAt = i;
      break;
    }
  }
  if (cutAt < 0) return null; // turnIndex out of range

  const kept = messages.slice(0, cutAt);
  const file = join(sessionsRoot(workspace), sessionId, "messages.jsonl");
  const ts = new Date().toISOString();
  const lines = kept.map((m) => JSON.stringify({ ts, ...m }));
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { removedMessages: messages.length - kept.length, keptMessages: kept.length };
}

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
  return join(sessionsRoot(workspace), sessionId, "checkpoints.jsonl");
}

/** Appends one pre-write snapshot to <session>/checkpoints.jsonl. */
export function appendCheckpoint(workspace: string, sessionId: string, entry: CheckpointEntry): void {
  const dir = join(sessionsRoot(workspace), sessionId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "checkpoints.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** Reads checkpoints in recorded order. Corrupt/malformed lines are skipped. */
export function readCheckpoints(workspace: string, sessionId: string): CheckpointEntry[] {
  const file = checkpointsFile(workspace, sessionId);
  if (!existsSync(file)) return [];
  const entries: CheckpointEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CheckpointEntry>;
      if (typeof parsed.path !== "string" || parsed.path === "") continue;
      if (parsed.before !== null && typeof parsed.before !== "string") continue;
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
      // corrupt line: skip, keep the rest usable
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
  const wsRoot = resolve(workspace);

  for (const entry of entries) {
    const target = resolve(wsRoot, entry.path);
    if (target === wsRoot || !target.startsWith(wsRoot + sep)) {
      result.skipped.push({ path: entry.path, reason: "path escapes the workspace" });
      continue;
    }

    try {
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
      result.skipped.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
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
): RewindResult {
  const firstPerPath = new Map<string, CheckpointEntry>();
  for (const entry of readCheckpoints(workspace, sessionId)) {
    if (!firstPerPath.has(entry.path)) firstPerPath.set(entry.path, entry);
  }
  return applyCheckpoints(workspace, firstPerPath.values(), opts);
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
): RewindResult {
  const earliestPerPath = new Map<string, CheckpointEntry>();
  for (const entry of readCheckpoints(workspace, sessionId)) {
    if ((entry.turn ?? 0) < turnIndex) continue;
    if (!earliestPerPath.has(entry.path)) earliestPerPath.set(entry.path, entry);
  }
  return applyCheckpoints(workspace, earliestPerPath.values(), opts);
}

/**
 * Forks a stored session into a fresh one: copies messages.jsonl (and
 * checkpoints.jsonl when present) into a new session directory under a new
 * id, and writes meta derived from the original ("(fork) " task prefix,
 * status "completed", fresh timestamps) so the fork is immediately resumable
 * without touching the original. Returns the new session id, or null when
 * the source session (meta or messages) is missing.
 */
export function forkSession(workspace: string, sessionId: string): string | null {
  const srcDir = join(sessionsRoot(workspace), sessionId);
  const srcMessages = join(srcDir, "messages.jsonl");
  const meta = readSessionMeta(workspace, sessionId);
  if (!meta || !existsSync(srcMessages)) return null;

  const id = newSessionId();
  const dstDir = join(sessionsRoot(workspace), id);
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(srcMessages, join(dstDir, "messages.jsonl"));
  const srcCheckpoints = join(srcDir, "checkpoints.jsonl");
  if (existsSync(srcCheckpoints)) copyFileSync(srcCheckpoints, join(dstDir, "checkpoints.jsonl"));

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
}

/**
 * Short display title for a session: the first non-empty line of the
 * session's summary.md (leading "#" markers stripped), else the meta task's
 * first line (whitespace collapsed), else the session id. Capped at 80 chars.
 */
export function sessionTitle(workspace: string, sessionId: string): string {
  try {
    const summary = readFileSync(join(sessionsRoot(workspace), sessionId, "summary.md"), "utf8");
    for (const raw of summary.split("\n")) {
      const line = raw.replace(/^#+\s*/, "").trim();
      if (line) return line.slice(0, 80);
    }
  } catch {
    // no summary yet (running/failed session): fall through to the task
  }
  const task = readSessionMeta(workspace, sessionId)?.task ?? "";
  const firstLine = task
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "");
  return firstLine ? firstLine.slice(0, 80) : sessionId;
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}
