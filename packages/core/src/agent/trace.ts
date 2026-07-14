import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentEvent, ChatMessage, SessionStatus, TokenUsage } from "@seekforge/shared";
import { resolveForWrite } from "../tools/sandbox.js";
import { compactMessages, estimateMessagesTokens } from "./context.js";
import {
  acquireSessionLease,
  assertSessionLease,
  isSessionRunActive,
  SessionBusyError,
  type SessionLease,
} from "./session-lease.js";

export type SessionTrace = {
  dir: string;
  message: (m: ChatMessage) => void;
  toolCall: (entry: Record<string, unknown>) => void;
  event: (e: AgentEvent) => void;
  summary: (markdown: string) => void;
};

/*
 * Persistent append fds for the trace's JSONL files. appendFileSync opens and
 * closes the file on EVERY call — three syscalls plus a path resolution per
 * line, which at events.jsonl rates (one line per AgentEvent) dominates the
 * trace cost. Instead each file gets ONE fd opened lazily in append mode and
 * every line is a single writeSync to it.
 *
 * Chosen over an fs.WriteStream deliberately: writeSync keeps the EXACT
 * durability and visibility semantics of appendFileSync — writes are
 * synchronous and write-through, so mid-session readers (loadSessionMessages
 * on resume / manual /compact, `seekforge replay` from another process, the
 * evolution scorer on tool-calls.jsonl) always see complete, current lines,
 * and nothing can be lost in a process-local buffer on an abrupt exit. A
 * WriteStream would need a dispose hook (SessionTrace has none, and the
 * session-end path lives in loop.ts) or an exit-time flush that cannot be
 * done synchronously.
 *
 * The cache is LRU-capped: a long-lived server creates many sessions over its
 * lifetime and must not accumulate one fd per session forever. Evicted fds
 * are closed (a later append simply reopens); all remaining fds are closed on
 * process exit. O_APPEND makes concurrent writers to the same file safe.
 */
const APPEND_FD_MAX = 32;
const appendFds = new Map<string, number>();
let appendFdsExitHookInstalled = false;

function closeAppendFdsUnder(dir: string): void {
  const prefix = `${dir}${sep}`;
  for (const [file, fd] of [...appendFds]) {
    if (!file.startsWith(prefix)) continue;
    appendFds.delete(file);
    try {
      closeSync(fd);
    } catch {
      // Best effort: deletion should still proceed if an fd was already closed.
    }
  }
}

function closeAppendFd(file: string): void {
  const fd = appendFds.get(file);
  if (fd === undefined) return;
  appendFds.delete(file);
  try {
    closeSync(fd);
  } catch {
    // The atomic replacement below remains safe if an fd was already closed.
  }
}

function appendLineSync(file: string, line: string): void {
  let fd = appendFds.get(file);
  if (fd !== undefined) {
    appendFds.delete(file); // re-set below: Map insertion order is the LRU order
  } else {
    fd = openSync(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    if (!appendFdsExitHookInstalled) {
      appendFdsExitHookInstalled = true;
      process.on("exit", () => {
        for (const openFd of appendFds.values()) {
          try {
            closeSync(openFd);
          } catch {
            // best-effort cleanup
          }
        }
        appendFds.clear();
      });
    }
    if (appendFds.size >= APPEND_FD_MAX) {
      const oldest = appendFds.entries().next().value!;
      appendFds.delete(oldest[0]);
      try {
        closeSync(oldest[1]);
      } catch {
        // best-effort eviction
      }
    }
  }
  appendFds.set(file, fd);
  writeSync(fd, line);
}

/** JSONL session trace under <workspace>/.seekforge/sessions/<id>/. */
export function createSessionTrace(workspace: string, sessionId: string): SessionTrace {
  const dir = sessionDir(workspace, sessionId, true);

  const append = (file: string, value: unknown) => {
    const target = sessionFile(workspace, sessionId, file, true);
    appendLineSync(target, `${JSON.stringify({ ts: new Date().toISOString(), ...(value as object) })}\n`);
  };

  return {
    dir,
    message: (m) => append("messages.jsonl", m),
    toolCall: (entry) => append("tool-calls.jsonl", entry),
    event: (e) => append("events.jsonl", e),
    summary: (markdown) => writeSessionText(workspace, sessionId, "summary.md", markdown),
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
  /**
   * Latest plan published via update_plan, persisted so a long-horizon task's
   * checklist survives across resume (restored into the system prompt). Kept
   * structural to avoid a trace -> tools dependency.
   */
  plan?: { step: string; status: "pending" | "in_progress" | "done" }[];
};

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_STATUSES = new Set<SessionStatus>([
  "idle", "running", "waiting_approval", "completed", "failed", "cancelled",
]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requirePhysicalDirectory(path: string, create: boolean): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return false;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(path) !== path) {
    throw new Error(`Unsafe session path: ${path}`);
  }
  return true;
}

function sessionsRoot(workspace: string, create = false): string {
  const root = realpathSync.native(resolve(workspace));
  const state = join(root, ".seekforge");
  const sessions = join(state, "sessions");
  if (!requirePhysicalDirectory(state, create)) return sessions;
  requirePhysicalDirectory(sessions, create);
  return sessions;
}

function sessionDir(workspace: string, sessionId: string, create = false): string {
  if (!SESSION_ID_RE.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const dir = join(sessionsRoot(workspace, create), sessionId);
  requirePhysicalDirectory(dir, create);
  return dir;
}

function sessionFile(
  workspace: string,
  sessionId: string,
  name: string,
  createDir = false,
): string {
  const dir = sessionDir(workspace, sessionId, createDir);
  const file = join(dir, name);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync.native(file) !== file) {
      throw new Error(`Unsafe session file: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

function readSessionText(workspace: string, sessionId: string, name: string): string {
  const file = sessionFile(workspace, sessionId, name);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeSessionText(workspace: string, sessionId: string, name: string, content: string): void {
  const target = sessionFile(workspace, sessionId, name, true);
  const dir = sessionDir(workspace, sessionId, true);
  const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    closeAppendFd(target);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function withSessionMutation<T>(
  workspace: string,
  sessionId: string,
  lease: SessionLease | undefined,
  mutate: (lease: SessionLease) => T,
): T {
  if (lease) {
    assertSessionLease(lease, workspace, sessionId);
    return mutate(lease);
  }
  const acquired = acquireSessionLease(workspace, sessionId);
  try {
    return mutate(acquired);
  } finally {
    acquired.release();
  }
}

function parseSessionMeta(value: unknown, expectedId: string): SessionMeta | undefined {
  if (!isRecord(value) || value["id"] !== expectedId || !SESSION_ID_RE.test(expectedId) || expectedId.includes("..")) {
    return undefined;
  }
  if (
    typeof value["task"] !== "string" || (value["mode"] !== "ask" && value["mode"] !== "edit") ||
    typeof value["status"] !== "string" || !SESSION_STATUSES.has(value["status"] as SessionStatus) ||
    typeof value["createdAt"] !== "string" || !Number.isFinite(Date.parse(value["createdAt"])) ||
    typeof value["updatedAt"] !== "string" || !Number.isFinite(Date.parse(value["updatedAt"])) ||
    (value["parentAgentId"] !== undefined && typeof value["parentAgentId"] !== "string")
  ) return undefined;
  const usage = value["usage"];
  if (usage !== undefined && (!isRecord(usage) ||
      !["promptTokens", "completionTokens", "cacheHitTokens", "costUsd"].every((key) =>
        typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0))) {
    return undefined;
  }
  const plan = value["plan"];
  if (plan !== undefined && (!Array.isArray(plan) || !plan.every((item) =>
    isRecord(item) && typeof item["step"] === "string" && typeof item["status"] === "string" &&
    PLAN_STATUSES.has(item["status"])))) {
    return undefined;
  }
  return value as SessionMeta;
}

function parseChatMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || !["system", "user", "assistant", "tool"].includes(String(value["role"])) ||
      typeof value["content"] !== "string" ||
      (value["toolCallId"] !== undefined && typeof value["toolCallId"] !== "string")) {
    return undefined;
  }
  const toolCalls = value["toolCalls"];
  if (toolCalls !== undefined && (!Array.isArray(toolCalls) || !toolCalls.every((call) =>
    isRecord(call) && typeof call["id"] === "string" && typeof call["name"] === "string" &&
    typeof call["argumentsJson"] === "string"))) {
    return undefined;
  }
  const { ts: _ts, ...message } = value;
  return message as ChatMessage;
}

export function writeSessionMeta(workspace: string, meta: SessionMeta): void {
  if (!parseSessionMeta(meta, meta.id)) throw new Error("Invalid session metadata");
  writeSessionText(workspace, meta.id, "session.json", `${JSON.stringify(meta, null, 2)}\n`);
}

export function readSessionMeta(workspace: string, sessionId: string): SessionMeta | undefined {
  try {
    return parseSessionMeta(
      JSON.parse(readSessionText(workspace, sessionId, "session.json")) as unknown,
      sessionId,
    );
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
    if (entry.isSymbolicLink()) throw new Error(`Unsafe session path: ${join(root, entry.name)}`);
    if (!entry.isDirectory()) continue;
    const meta = readSessionMeta(workspace, entry.name);
    if (!meta) continue;
    if (meta.parentAgentId && !opts.includeSubagents) continue;
    metas.push(meta);
  }
  return metas.sort((a, b) => {
    const chronological = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return chronological || a.id.localeCompare(b.id);
  });
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
    if (meta.status === "running" || isSessionRunActive(workspace, meta.id)) continue;
    const tooOld = cutoff !== undefined && new Date(meta.createdAt).getTime() < cutoff;
    const overflow = !meta.parentAgentId && !keptByRecency.has(meta.id);
    if (!tooOld && !overflow) continue;
    if (opts.dryRun) {
      removed.push(meta.id);
      continue;
    }
    try {
      withSessionMutation(workspace, meta.id, undefined, () => {
        const dir = sessionDir(workspace, meta.id);
        closeAppendFdsUnder(dir);
        rmSync(dir, { recursive: true, force: true });
      });
      removed.push(meta.id);
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
    }
  }
  return { removed, kept: all.length - removed.length };
}

/**
 * Removes a single session directory (.seekforge/sessions/<id>/). Returns
 * whether the session existed before deletion. Mirrors pruneSessions' per-id
 * removal; best-effort recursive delete.
 */
export function deleteSession(workspace: string, id: string, lease?: SessionLease): boolean {
  return withSessionMutation(workspace, id, lease, () => {
    const dir = sessionDir(workspace, id);
    if (!existsSync(dir)) return false;
    closeAppendFdsUnder(dir);
    rmSync(dir, { recursive: true, force: true });
    return true;
  });
}

/**
 * Replays the longest valid JSONL prefix. A partial tail is expected after a
 * crash; records after any malformed line may depend on the missing record and
 * must not be replayed independently (especially tool calls/results).
 */
export function loadSessionMessages(workspace: string, sessionId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of readSessionText(workspace, sessionId, "messages.jsonl").split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = parseChatMessage(JSON.parse(line) as unknown);
      if (!message) break;
      messages.push(message);
    } catch {
      break;
    }
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
export function compactSessionNow(
  workspace: string,
  sessionId: string,
  lease?: SessionLease,
): ManualCompactionResult | null {
  return withSessionMutation(workspace, sessionId, lease, (ownedLease) => {
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

    rewriteSessionMessages(workspace, sessionId, compacted.messages, ownedLease);
    return {
      droppedTurns: compacted.droppedTurns,
      beforeTokens,
      afterTokens: estimateMessagesTokens(compacted.messages),
    };
  });
}

/**
 * Replaces a session's messages.jsonl wholesale (manual compaction flows
 * that build the new history elsewhere, e.g. LLM-summarized /compact).
 */
export function rewriteSessionMessages(
  workspace: string,
  sessionId: string,
  messages: ChatMessage[],
  lease?: SessionLease,
): void {
  withSessionMutation(workspace, sessionId, lease, () => {
    const ts = new Date().toISOString();
    const lines = messages.map((m) => JSON.stringify({ ts, ...m }));
    writeSessionText(workspace, sessionId, "messages.jsonl", `${lines.join("\n")}\n`);
  });
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
  lease?: SessionLease,
): TruncateResult | null {
  return withSessionMutation(workspace, sessionId, lease, () => {
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
    const ts = new Date().toISOString();
    const lines = kept.map((m) => JSON.stringify({ ts, ...m }));
    writeSessionText(workspace, sessionId, "messages.jsonl", `${lines.join("\n")}\n`);
    return { removedMessages: messages.length - kept.length, keptMessages: kept.length };
  });
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
      const reason = (err as { code?: unknown }).code === "outside_workspace"
        ? "path escapes the workspace"
        : err instanceof Error ? err.message : String(err);
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

/**
 * Short display title for a session: the first non-empty line of the
 * session's summary.md (leading "#" markers stripped), else the meta task's
 * first line (whitespace collapsed), else the session id. Capped at 80 chars.
 */
export function sessionTitle(workspace: string, sessionId: string): string {
  try {
    const summary = readSessionText(workspace, sessionId, "summary.md");
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
