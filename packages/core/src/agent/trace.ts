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
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import type { AgentEvent, ChatMessage, SessionStatus, TokenUsage } from "@seekforge/shared";
import { compactMessages, estimateMessagesTokens } from "./context.js";
import {
  acquireSessionLease,
  assertSessionLease,
  isSessionRunActive,
  SessionBusyError,
  type SessionLease,
} from "./session-lease.js";
import { writeFileAtomic } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import { installProcessTeardown } from "../util/process-teardown.js";

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

export function appendLineSync(file: string, line: string): void {
  let fd = appendFds.get(file);
  if (fd !== undefined) {
    appendFds.delete(file); // re-set below: Map insertion order is the LRU order
  } else {
    fd = openSync(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    if (!appendFdsExitHookInstalled) {
      appendFdsExitHookInstalled = true;
      // Only 'exit' is needed: O_APPEND writes hit the kernel immediately, so
      // an unclosed fd loses no data — closing here is tidiness, not safety.
      installProcessTeardown({
        onExit: () => {
          for (const openFd of appendFds.values()) {
            try {
              closeSync(openFd);
            } catch {
              // best-effort cleanup
            }
          }
          appendFds.clear();
        },
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
  "idle",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);

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

export function sessionFile(workspace: string, sessionId: string, name: string, createDir = false): string {
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

export function readSessionText(workspace: string, sessionId: string, name: string): string {
  const file = sessionFile(workspace, sessionId, name);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function writeSessionText(workspace: string, sessionId: string, name: string, content: string): void {
  const target = sessionFile(workspace, sessionId, name, true);
  sessionDir(workspace, sessionId, true); // ensure the session dir exists
  // Drop any cached append fd for this target before the atomic rename replaces
  // the file underneath it.
  closeAppendFd(target);
  writeFileAtomic(target, content);
}

export function withSessionMutation<T>(
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
    typeof value["task"] !== "string" ||
    (value["mode"] !== "ask" && value["mode"] !== "edit") ||
    typeof value["status"] !== "string" ||
    !SESSION_STATUSES.has(value["status"] as SessionStatus) ||
    typeof value["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["createdAt"])) ||
    typeof value["updatedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["updatedAt"])) ||
    (value["parentAgentId"] !== undefined && typeof value["parentAgentId"] !== "string")
  )
    return undefined;
  const usage = value["usage"];
  if (
    usage !== undefined &&
    (!isRecord(usage) ||
      !["promptTokens", "completionTokens", "cacheHitTokens", "costUsd"].every(
        (key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0,
      ))
  ) {
    return undefined;
  }
  const plan = value["plan"];
  if (
    plan !== undefined &&
    (!Array.isArray(plan) ||
      !plan.every(
        (item) =>
          isRecord(item) &&
          typeof item["step"] === "string" &&
          typeof item["status"] === "string" &&
          PLAN_STATUSES.has(item["status"]),
      ))
  ) {
    return undefined;
  }
  return value as SessionMeta;
}

function parseChatMessage(value: unknown): ChatMessage | undefined {
  if (
    !isRecord(value) ||
    !["system", "user", "assistant", "tool"].includes(String(value["role"])) ||
    typeof value["content"] !== "string" ||
    (value["toolCallId"] !== undefined && typeof value["toolCallId"] !== "string")
  ) {
    return undefined;
  }
  const toolCalls = value["toolCalls"];
  if (
    toolCalls !== undefined &&
    (!Array.isArray(toolCalls) ||
      !toolCalls.every(
        (call) =>
          isRecord(call) &&
          typeof call["id"] === "string" &&
          typeof call["name"] === "string" &&
          typeof call["argumentsJson"] === "string",
      ))
  ) {
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
    return parseSessionMeta(JSON.parse(readSessionText(workspace, sessionId, "session.json")) as unknown, sessionId);
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
  const cutoff = opts.olderThanDays !== undefined ? Date.now() - opts.olderThanDays * 86_400_000 : undefined;

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
function loadRawSessionMessages(workspace: string, sessionId: string): ChatMessage[] {
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

type CompactionSnapshot = {
  version: 1;
  sourceMessageCount: number;
  sourceFingerprint: string;
  messages: ChatMessage[];
};

function messagesFingerprint(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function parseCompactionSnapshot(value: unknown): CompactionSnapshot | undefined {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Number.isInteger(value["sourceMessageCount"]) ||
    (value["sourceMessageCount"] as number) < 0 ||
    typeof value["sourceFingerprint"] !== "string" ||
    !Array.isArray(value["messages"])
  ) {
    return undefined;
  }
  const messages: ChatMessage[] = [];
  for (const raw of value["messages"]) {
    const message = parseChatMessage(raw);
    if (!message) return undefined;
    messages.push(message);
  }
  return { ...value, messages } as CompactionSnapshot;
}

/**
 * Loads the audit JSONL through the latest valid derived compaction snapshot.
 * The source fingerprint makes stale snapshots fail closed after rewind,
 * manual compaction, or any external trace repair.
 */
export function loadSessionMessages(workspace: string, sessionId: string): ChatMessage[] {
  const raw = loadRawSessionMessages(workspace, sessionId);
  try {
    const snapshot = parseCompactionSnapshot(
      JSON.parse(readSessionText(workspace, sessionId, "compaction.json")) as unknown,
    );
    if (!snapshot || snapshot.sourceMessageCount > raw.length) return raw;
    const source = raw.slice(0, snapshot.sourceMessageCount);
    if (messagesFingerprint(source) !== snapshot.sourceFingerprint) return raw;
    return [...snapshot.messages, ...raw.slice(snapshot.sourceMessageCount)];
  } catch {
    return raw;
  }
}

/** Persists a derived resume snapshot while keeping messages.jsonl as audit truth. */
export function writeCompactionSnapshot(
  workspace: string,
  sessionId: string,
  messages: ChatMessage[],
  lease?: SessionLease,
): boolean {
  return withSessionMutation(workspace, sessionId, lease, () => {
    const raw = loadRawSessionMessages(workspace, sessionId);
    if (raw.length === 0 || messages.length >= raw.length) return false;
    const snapshot: CompactionSnapshot = {
      version: 1,
      sourceMessageCount: raw.length,
      sourceFingerprint: messagesFingerprint(raw),
      messages,
    };
    writeSessionText(workspace, sessionId, "compaction.json", `${JSON.stringify(snapshot, null, 2)}\n`);
    return true;
  });
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
  // Crypto-strong suffix (48 bits) instead of Math.random's 6 base-36 chars:
  // burst-dispatched subagents create sessions in the same second, and a
  // suffix collision would make two sessions share a directory and interleave
  // their messages.jsonl (breaking the longest-valid-prefix replay). Loops
  // already use randomUUID for the same reason.
  const rand = randomBytes(6).toString("hex");
  return `${stamp}-${rand}`;
}
