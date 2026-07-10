/**
 * Stored-session routes: list/prune/compact/fork/delete, transcript reads
 * (messages, user-turn index, audit), backtracking, and POST /api/rewind
 * (file-checkpoint restore).
 */

import {
  buildSessionAudit,
  compactSessionNow,
  deleteSession,
  forkSession,
  listSessions,
  loadSessionMessages,
  pruneSessions,
  readCheckpoints,
  readSessionMeta,
  renderSessionAuditMarkdown,
  rewindSession,
  rewindSessionToTurn,
  truncateSessionAtUserTurn,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { isSafeId } from "../ids.js";
import type { RouteCtx } from "./context.js";

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/sessions") {
    return sendJson(res, 200, listSessions(workspace));
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
    if (
      keepLast !== undefined &&
      (typeof keepLast !== "number" || !Number.isInteger(keepLast) || keepLast < 0)
    ) {
      return sendApiError(res, 400, "bad_request", "keepLast must be a non-negative integer");
    }
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      return sendApiError(res, 400, "bad_request", "dryRun must be a boolean");
    }
    return sendJson(
      res,
      200,
      pruneSessions(workspace, {
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(keepLast !== undefined ? { keepLast } : {}),
        ...(dryRun !== undefined ? { dryRun } : {}),
      }),
    );
  }

  // Manual compaction of a stored session (folds the middle into a digest).
  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "compact") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    if (!readSessionMeta(workspace, id)) {
      return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    }
    return sendJson(res, 200, compactSessionNow(workspace, id));
  }

  // Fork a stored session into a NEW session id (the original is untouched).
  if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "fork") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    const forked = forkSession(workspace, id);
    if (forked === null) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    return sendJson(res, 200, { id: forked });
  }

  // Delete a single session directory.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "sessions") {
    const id = segs[2]!;
    if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
    const deleted = deleteSession(workspace, id);
    if (!deleted) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
    return sendJson(res, 200, { deleted });
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
    return sendJson(res, 200, { meta, messages });
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
    // Truncating validates the turn index (null = turn 0 / out of range);
    // file checkpoints are restored only after that validation passed.
    const truncated = truncateSessionAtUserTurn(workspace, id, turn);
    if (truncated === null) {
      return sendApiError(res, 400, "bad_request", `turn ${turn} is not backtrackable (turn 0 or out of range)`);
    }
    let filesResult: { restored: number; deleted: number; skipped: number } | null = null;
    if (files === true) {
      const r = rewindSessionToTurn(workspace, id, turn);
      filesResult = { restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length };
    }
    return sendJson(res, 200, { ...truncated, files: filesResult });
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
    if (readCheckpoints(workspace, sessionId).length === 0) {
      return sendApiError(res, 404, "not_found", `session ${sessionId} has no checkpoints to rewind`);
    }
    return sendJson(res, 200, rewindSession(workspace, sessionId, { dryRun: dryRun === true }));
  }
}
