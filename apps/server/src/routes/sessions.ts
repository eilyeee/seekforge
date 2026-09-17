/**
 * Stored-session routes: list/prune/compact/fork/delete, transcript reads
 * (messages, user-turn index, audit), backtracking, and POST /api/rewind
 * (file-checkpoint restore).
 */

import {
  buildSessionAudit,
  acquireSessionLease,
  compactSessionNow,
  deleteSession,
  forkSession,
  hasActiveSessionRuns,
  isSessionRunActive,
  listSessions,
  loadSessionMessages,
  pruneSessions,
  readCheckpoints,
  readSessionMeta,
  renameSession,
  renderSessionAuditMarkdown,
  rewindSession,
  rewindSessionToTurn,
  SessionBusyError,
  sessionName,
  truncateSessionAtUserTurn,
} from "@seekforge/core";
import type { AgentEvent, ToolResult } from "@seekforge/shared";
import { createServerHookEvaluator, serverHooks } from "../agent.js";
import { readProjectFile } from "../config.js";
import { readJsonBody, requestAbortSignal, sendApiError, sendJson } from "../http.js";
import { isSafeId } from "../ids.js";
import type { RouteCtx } from "./context.js";

type HistoricalAgentEvent = Extract<AgentEvent, { type: `subagent.${string}` | "tool.started" | "tool.completed" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Core's closed color set (subagents/fields.ts parseColor, not exported): what
 * core emits live. A stored value outside it is dropped from the replay.
 */
const SUBAGENT_COLOR_RE = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})|red|orange|yellow|green|blue|purple|pink|cyan)$/;
/** Core bounds an agent_report line; a stored one longer than this is not core's. */
const MAX_REPLAYED_REPORT_CHARS = 2_000;

function persistedOrchestrationEvent(value: unknown): HistoricalAgentEvent | null | false {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "tool.started") {
    return value.toolName === "dispatch_team"
      ? { type: "tool.started", toolName: "dispatch_team", args: value.args }
      : null;
  }
  if (value.type === "tool.completed") {
    if (value.toolName !== "dispatch_team") return null;
    if (!isRecord(value.result) || typeof value.result.ok !== "boolean") return false;
    return { type: "tool.completed", toolName: "dispatch_team", result: value.result as ToolResult };
  }
  if (!value.type.startsWith("subagent.")) return null;
  const dispatchId = value.dispatchId;
  const agentId = value.agentId;
  const task = value.task;
  if (typeof dispatchId !== "string" || typeof agentId !== "string" || typeof task !== "string") return false;
  const subSessionId = typeof value.subSessionId === "string" ? value.subSessionId : undefined;
  // Presentation-only extras: kept when well-formed, dropped (not fatal) when not.
  const color = typeof value.color === "string" && SUBAGENT_COLOR_RE.test(value.color) ? value.color : undefined;
  const colorField = color !== undefined ? { color } : {};
  if (value.type === "subagent.started" && value.status === "running") {
    return { type: value.type, dispatchId, agentId, task, status: "running", ...colorField };
  }
  if (value.type === "subagent.step" && value.status === "running" && typeof value.toolName === "string") {
    const message =
      typeof value.message === "string" && value.message.length <= MAX_REPLAYED_REPORT_CHARS
        ? value.message
        : undefined;
    return {
      type: value.type,
      dispatchId,
      agentId,
      task,
      status: "running",
      toolName: value.toolName,
      ...(subSessionId ? { subSessionId } : {}),
      ...(message !== undefined ? { message } : {}),
      ...colorField,
    };
  }
  if (value.type === "subagent.completed" && value.status === "done" && typeof value.resultSummary === "string") {
    return {
      type: value.type,
      dispatchId,
      agentId,
      task,
      status: "done",
      resultSummary: value.resultSummary,
      ...(subSessionId ? { subSessionId } : {}),
      ...colorField,
    };
  }
  if (
    value.type === "subagent.failed" &&
    value.status === "failed" &&
    typeof value.resultSummary === "string" &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return {
      type: value.type,
      dispatchId,
      agentId,
      task,
      status: "failed",
      resultSummary: value.resultSummary,
      error: { code: value.error.code, message: value.error.message },
      ...(subSessionId ? { subSessionId } : {}),
      ...colorField,
    };
  }
  if (value.type === "subagent.cancelled" && value.status === "cancelled" && typeof value.reason === "string") {
    return {
      type: value.type,
      dispatchId,
      agentId,
      task,
      status: "cancelled",
      reason: value.reason,
      ...(subSessionId ? { subSessionId } : {}),
      ...colorField,
    };
  }
  return false;
}

function loadOrchestrationEvents(workspace: string, sessionId: string): HistoricalAgentEvent[] {
  const raw = readProjectFile(workspace, `.seekforge/sessions/${sessionId}/events.jsonl`);
  if (raw === undefined) return [];
  const events: HistoricalAgentEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      break;
    }
    const event = persistedOrchestrationEvent(parsed);
    if (event === false) break;
    if (event !== null) events.push(event);
  }
  return events;
}

/** Input bound for a rename; core stores at most 80 characters of it. */
const MAX_SESSION_NAME_INPUT = 1_000;

/** SessionMeta plus the user-chosen name, when there is one. */
function withName<T extends { id: string }>(workspace: string, meta: T): T & { name?: string } {
  const name = sessionName(workspace, meta.id);
  return name === undefined ? meta : { ...meta, name };
}

function sessionMutation<T>(res: RouteCtx["res"], sessionId: string, mutate: () => T): { value: T } | undefined {
  try {
    return { value: mutate() };
  } catch (error) {
    if (!(error instanceof SessionBusyError)) throw error;
    sendApiError(res, 409, "session_busy", `session is running: ${sessionId}`);
    return undefined;
  }
}

/** sessionMutation for an async mutation (the lease is taken inside it). */
async function asyncSessionMutation<T>(
  res: RouteCtx["res"],
  sessionId: string,
  mutate: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  try {
    return { value: await mutate() };
  } catch (error) {
    if (!(error instanceof SessionBusyError)) throw error;
    sendApiError(res, 409, "session_busy", `session is running: ${sessionId}`);
    return undefined;
  }
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace, rest }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/sessions") {
    return sendJson(
      res,
      200,
      listSessions(workspace).map((meta) => withName(workspace, meta)),
    );
  }

  // Prune old sessions. Checked before DELETE :id (and before GET :id) so
  // "prune" is never treated as a session id.
  if (method === "POST" && path === "/api/sessions/prune") {
    const body = await readJsonBody(req, res, { emptyOk: true }); // all params optional
    if (body === undefined) return;
    const { olderThanDays, keepLast, dryRun } = (body ?? {}) as {
      olderThanDays?: unknown;
      keepLast?: unknown;
      dryRun?: unknown;
    };
    if (
      olderThanDays !== undefined &&
      (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays < 0)
    ) {
      return sendApiError(res, 400, "bad_request", "olderThanDays must be a non-negative number");
    }
    if (keepLast !== undefined && (typeof keepLast !== "number" || !Number.isInteger(keepLast) || keepLast < 0)) {
      return sendApiError(res, 400, "bad_request", "keepLast must be a non-negative integer");
    }
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      return sendApiError(res, 400, "bad_request", "dryRun must be a boolean");
    }
    if (dryRun !== true && hasActiveSessionRuns(workspace)) {
      return sendApiError(res, 409, "session_busy", "cannot prune while a session is running");
    }
    const pruned = pruneSessions(workspace, {
      ...(olderThanDays !== undefined ? { olderThanDays } : {}),
      ...(keepLast !== undefined ? { keepLast } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
    });
    if (dryRun !== true) for (const id of pruned.removed) rest.sessionDispatch?.close(workspace, id);
    return sendJson(res, 200, pruned);
  }

  // Manual compaction of a stored session (folds the middle into a digest),
  // wrapped in the user's preCompact / postCompact hooks. Core takes the
  // session lease before the first hook and holds it through the rewrite, so a
  // run cannot start on this session while its hooks are deciding; a client
  // that goes away cancels the hooks.
  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "compact") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    if (isSessionRunActive(workspace, id)) {
      return sendApiError(res, 409, "session_busy", `session is running: ${id}`);
    }
    if (!readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    const operation = requestAbortSignal(req, res);
    // A failing preCompact/postCompact hook is not a refusal (neither stage
    // blocks on failure); its message is reported with the result.
    const failures: string[] = [];
    const result = await asyncSessionMutation(res, id, () =>
      compactSessionNow(workspace, id, undefined, {
        hooks: serverHooks(workspace),
        signal: operation.signal,
        evaluate: createServerHookEvaluator(workspace),
        onError: (message) => failures.push(message),
      }),
    ).finally(() => operation.cleanup());
    if (!result || res.headersSent) return;
    const value = result.value;
    if (value === null) return sendJson(res, 200, null);
    if ("blocked" in value) {
      // Nothing was changed. The error envelope keeps old clients showing the
      // reason; the extra fields carry the hooks' notices.
      return sendJson(res, 409, {
        error: { code: "blocked_by_hook", message: value.reason },
        blocked: true,
        reason: value.reason,
        notices: [...value.notices, ...failures],
      });
    }
    const { notices: hookNotices = [], ...counts } = value;
    const notices = [...hookNotices, ...failures];
    return sendJson(res, 200, notices.length > 0 ? { ...counts, notices } : counts);
  }

  // Fork a stored session into a NEW session id (the original is untouched).
  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "fork") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    if (isSessionRunActive(workspace, id)) {
      return sendApiError(res, 409, "session_busy", `session is running: ${id}`);
    }
    const result = sessionMutation(res, id, () => forkSession(workspace, id));
    if (!result) return;
    const forked = result.value;
    if (forked === null) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    return sendJson(res, 200, { id: forked });
  }

  // Delete a single session directory.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "sessions") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    if (isSessionRunActive(workspace, id)) {
      return sendApiError(res, 409, "session_busy", `session is running: ${id}`);
    }
    const result = sessionMutation(res, id, () => deleteSession(workspace, id));
    if (!result) return;
    const deleted = result.value;
    if (!deleted) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    // Its background subagents have no session left to report to.
    rest.sessionDispatch?.close(workspace, id);
    return sendJson(res, 200, { deleted });
  }

  // Name a session (an empty name clears it). The name lives beside the
  // session, so renaming a running session is safe and survives its next save.
  if (method === "PATCH" && segs.length === 3 && segs[1] === "sessions") {
    const id = segs[2]!;
    if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { name } = (body ?? {}) as { name?: unknown };
    if (typeof name !== "string" || name.length > MAX_SESSION_NAME_INPUT) {
      return sendApiError(
        res,
        400,
        "bad_request",
        `body must be {name: string} (at most ${MAX_SESSION_NAME_INPUT} characters)`,
      );
    }
    renameSession(workspace, id, name);
    return sendJson(res, 200, { id, name: sessionName(workspace, id) ?? null });
  }

  // Files the session wrote, from its checkpoint log (workspace-relative,
  // first-write order). Empty for a session that never edited anything.
  if (method === "GET" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "changes") {
    const id = segs[2]!;
    if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    const files = [...new Set(readCheckpoints(workspace, id).map((entry) => entry.path))];
    return sendJson(res, 200, { files });
  }

  if (method === "GET" && segs.length === 3 && segs[1] === "sessions") {
    const id = segs[2]!;
    const meta = isSafeId(id) ? readSessionMeta(workspace, id) : undefined;
    if (!meta) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    let messages: ReturnType<typeof loadSessionMessages> = [];
    try {
      messages = loadSessionMessages(workspace, id);
    } catch {
      // a session may exist with no messages.jsonl yet
    }
    let events: HistoricalAgentEvent[] = [];
    try {
      events = loadOrchestrationEvents(workspace, id);
    } catch {
      // A legacy session may have no readable events file; messages still load.
    }
    return sendJson(res, 200, { meta: withName(workspace, meta), messages, events });
  }

  // User-turn index of a session: every role:"user" message in file order,
  // numbered 0..N-1 — the SAME all-user-messages indexing that
  // truncateSessionAtUserTurn / rewindSessionToTurn use. Turn 0 (the
  // original task) is flagged not backtrackable: truncating before it
  // would empty the conversation.
  if (method === "GET" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "turns") {
    const id = segs[2]!;
    if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    let messages: ReturnType<typeof loadSessionMessages> = [];
    try {
      messages = loadSessionMessages(workspace, id);
    } catch {
      // no messages.jsonl yet -> zero turns
    }
    const turns = messages
      .filter((m) => m.role === "user")
      .map((m, turn) => ({ turn, text: m.content, backtrackable: turn > 0 }));
    return sendJson(res, 200, turns);
  }

  // Reviewable audit of a stored session: structured summary plus rendered
  // markdown. buildSessionAudit returns null for an unknown id / missing
  // trace, which we surface as 404.
  if (method === "GET" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "audit") {
    const id = segs[2]!;
    if (!isSafeId(id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    const audit = buildSessionAudit(workspace, id);
    if (!audit) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    return sendJson(res, 200, { markdown: renderSessionAuditMarkdown(audit), audit });
  }

  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "backtrack") {
    const id = segs[2]!;
    if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { turn, files } = (body ?? {}) as { turn?: unknown; files?: unknown };
    if (typeof turn !== "number" || !Number.isInteger(turn)) {
      return sendApiError(res, 400, "bad_request", "body must be {turn: integer, files?: boolean}");
    }
    let lease: ReturnType<typeof acquireSessionLease>;
    try {
      // Acquire only after the request body is complete, immediately before
      // mutation, and hold through both trace truncation and file rewind.
      lease = acquireSessionLease(workspace, id);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", `session is running: ${id}`);
      }
      throw error;
    }
    try {
      let userTurns = 0;
      try {
        userTurns = loadSessionMessages(workspace, id).filter((message) => message.role === "user").length;
      } catch {
        userTurns = 0;
      }
      if (turn <= 0 || turn >= userTurns) {
        return sendApiError(res, 400, "bad_request", `turn ${turn} is not backtrackable (turn 0 or out of range)`);
      }
      let filesResult: { restored: number; deleted: number; skipped: number; warnings: string[] } | null = null;
      if (files === true) {
        const r = rewindSessionToTurn(workspace, id, turn, {}, lease);
        filesResult = {
          restored: r.restored.length,
          deleted: r.deleted.length,
          skipped: r.skipped.length,
          warnings: r.warnings,
        };
      }
      const truncated = truncateSessionAtUserTurn(workspace, id, turn, lease);
      if (truncated === null) {
        throw new Error(`validated backtrack turn became unavailable: ${turn}`);
      }
      return sendJson(res, 200, { ...truncated, files: filesResult });
    } finally {
      lease.release();
    }
  }

  if (method === "POST" && path === "/api/rewind") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { sessionId, dryRun } = (body ?? {}) as { sessionId?: unknown; dryRun?: unknown };
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return sendApiError(res, 400, "bad_request", "body must be {sessionId, dryRun?}");
    }
    if (!isSafeId(sessionId) || !readSessionMeta(workspace, sessionId)) {
      return sendApiError(res, 404, "not_found", `session not found: ${sessionId}`);
    }
    if (isSessionRunActive(workspace, sessionId)) {
      return sendApiError(res, 409, "session_busy", `session is running: ${sessionId}`);
    }
    if (readCheckpoints(workspace, sessionId).length === 0) {
      return sendApiError(res, 404, "not_found", `session ${sessionId} has no checkpoints to rewind`);
    }
    const result = sessionMutation(res, sessionId, () =>
      rewindSession(workspace, sessionId, { dryRun: dryRun === true }),
    );
    if (!result) return;
    return sendJson(res, 200, result.value);
  }
}
