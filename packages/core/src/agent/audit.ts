/**
 * Session-audit export: turns a stored session's trace into a reviewable,
 * deterministic report of what the agent actually did — the prompts it was
 * given, the assistant replies, every tool call with a compacted preview of
 * its arguments and outcome, and the files it changed. Pure functions over the
 * on-disk trace (no model calls, no Date.now()), reinforcing SeekForge's
 * local-first, auditable positioning.
 *
 * Raw values (tool arguments, tool results) are preserved verbatim and only
 * truncated for length — the report must not re-interpret or execute anything
 * it reads back, so an auditor sees exactly what the run recorded.
 */

import type { ChatMessage, TokenUsage } from "@seekforge/shared";
import { loadSessionMessages, readCheckpoints, readSessionMeta } from "./trace.js";

/** One tool call the assistant made, paired with its recorded outcome. */
export type AuditToolCall = {
  id: string;
  name: string;
  /** argumentsJson compacted (whitespace collapsed) and truncated for length. */
  argsSummary: string;
  /**
   * true/false from the recorded tool result; null when NO result was recorded
   * (an interrupted turn) — rendered distinctly so an unanswered call isn't
   * shown as a success.
   */
  ok: boolean | null;
  /** Truncated preview of the raw tool result content (verbatim); "" when none. */
  resultPreview: string;
};

/** One user turn: the prompt, the assistant's reply, and the tools it invoked. */
export type AuditTurn = {
  /** 0-based user-turn index (aligned with trace's all-user-messages indexing). */
  index: number;
  /** The user/task text for this turn. */
  user: string;
  /** Assistant text across this turn (multiple messages joined). */
  assistant: string;
  toolCalls: AuditToolCall[];
};

/** A file the run touched, from the checkpoint snapshots. */
export type AuditFileChange = {
  /** Workspace-relative path. */
  path: string;
  /** True when the run created the file (a checkpoint recorded before === null). */
  created: boolean;
  /** User-turn indices that wrote the file, ascending. */
  turns: number[];
};

export type SessionAudit = {
  meta: {
    id: string;
    task: string;
    mode: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    usage?: TokenUsage;
  };
  turns: AuditTurn[];
  filesChanged: AuditFileChange[];
  totals: {
    userTurns: number;
    assistantMessages: number;
    toolCalls: number;
    filesChanged: number;
    tokens: { prompt: number; completion: number; cacheHit: number };
    costUsd: number;
  };
};

/** Collapse whitespace and truncate `text` to `max` chars with an ellipsis. */
function compactTruncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Truncate raw text to `max` chars (verbatim, only length-limited). */
function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Compact a tool call's raw argumentsJson for display. Re-serialized without
 * whitespace when it parses as JSON (never re-interpreted — a compact echo of
 * the same values), else the raw string; then truncated for length.
 */
function summarizeArgs(argumentsJson: string): string {
  let compact = argumentsJson;
  try {
    compact = JSON.stringify(JSON.parse(argumentsJson));
  } catch {
    // Not valid JSON (rare/legacy): fall back to the raw string.
  }
  return compactTruncate(compact);
}

/**
 * Classify a recorded tool result. loop.ts serializes results as
 * `{"ok":true,"data":…}` / `{"ok":false,"error":…}`; when that parses we trust
 * the `ok` flag, otherwise we conservatively treat a leading "error" as failure.
 */
function isErrorResult(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { ok?: unknown };
    if (typeof parsed.ok === "boolean") return !parsed.ok;
  } catch {
    // Non-JSON result: fall through to the heuristic.
  }
  return /^\s*error\b/i.test(content);
}

/**
 * Assembles a reviewable audit of a stored session from its on-disk trace.
 * Returns null when the session has no readable messages (missing/unreadable
 * trace). Deterministic: derives everything from the recorded files.
 */
export function buildSessionAudit(workspace: string, sessionId: string): SessionAudit | null {
  let messages: ChatMessage[];
  try {
    messages = loadSessionMessages(workspace, sessionId);
  } catch {
    return null; // no messages.jsonl → nothing to audit
  }
  if (messages.length === 0) return null;

  const turns: AuditTurn[] = [];
  let current: AuditTurn | null = null;
  // Tool-call ids are scoped to one assistant response by the provider. Keep
  // only that response's unanswered calls here so a later turn reusing an id
  // cannot rewrite an earlier audit result.
  let pendingCalls = new Map<string, AuditToolCall[]>();
  let assistantMessages = 0;
  let toolCallCount = 0;

  for (const m of messages) {
    if (m.role === "system") continue; // chrome, not part of the visible run
    if (m.role === "user") {
      pendingCalls = new Map();
      current = { index: turns.length, user: m.content, assistant: "", toolCalls: [] };
      turns.push(current);
      continue;
    }
    if (m.role === "assistant") {
      // An assistant message before any user turn (unusual) opens turn 0.
      if (!current) {
        current = { index: turns.length, user: "", assistant: "", toolCalls: [] };
        turns.push(current);
      }
      assistantMessages += 1;
      if (m.content.trim()) {
        current.assistant = current.assistant ? `${current.assistant}\n\n${m.content}` : m.content;
      }
      pendingCalls = new Map();
      for (const call of m.toolCalls ?? []) {
        toolCallCount += 1;
        const auditCall: AuditToolCall = {
          id: call.id,
          name: call.name,
          argsSummary: summarizeArgs(call.argumentsJson),
          ok: null,
          resultPreview: "",
        };
        current.toolCalls.push(auditCall);
        const sameId = pendingCalls.get(call.id) ?? [];
        sameId.push(auditCall);
        pendingCalls.set(call.id, sameId);
      }
      continue;
    }
    if (m.role === "tool" && m.toolCallId) {
      const sameId = pendingCalls.get(m.toolCallId);
      const call = sameId?.shift();
      if (call) {
        call.ok = !isErrorResult(m.content);
        call.resultPreview = truncate(m.content);
        if (sameId?.length === 0) pendingCalls.delete(m.toolCallId);
      }
    }
  }

  // Dedupe checkpoint paths → created flag + the turns that wrote each path.
  const byPath = new Map<string, { created: boolean; turns: Set<number> }>();
  for (const cp of readCheckpoints(workspace, sessionId)) {
    const entry = byPath.get(cp.path) ?? { created: false, turns: new Set<number>() };
    if (cp.before === null) entry.created = true;
    entry.turns.add(cp.turn ?? 0);
    byPath.set(cp.path, entry);
  }
  const filesChanged: AuditFileChange[] = [...byPath.entries()].map(([path, v]) => ({
    path,
    created: v.created,
    turns: [...v.turns].sort((a, b) => a - b),
  }));

  const meta = readSessionMeta(workspace, sessionId);
  const usage = meta?.usage;

  return {
    meta: {
      id: meta?.id ?? sessionId,
      task: meta?.task ?? "",
      mode: meta?.mode ?? "",
      status: meta?.status ?? "",
      createdAt: meta?.createdAt ?? "",
      updatedAt: meta?.updatedAt ?? "",
      ...(usage ? { usage } : {}),
    },
    turns,
    filesChanged,
    totals: {
      userTurns: turns.filter((t) => t.user !== "").length,
      assistantMessages,
      toolCalls: toolCallCount,
      filesChanged: filesChanged.length,
      tokens: {
        prompt: usage?.promptTokens ?? 0,
        completion: usage?.completionTokens ?? 0,
        cacheHit: usage?.cacheHitTokens ?? 0,
      },
      costUsd: usage?.costUsd ?? 0,
    },
  };
}

/**
 * Renders a SessionAudit as scannable markdown: a header (id/title/task/mode/
 * status/timespan/totals), a "Files changed" section, and a per-turn timeline.
 * Deterministic — no clock, no environment reads.
 */
export function renderSessionAuditMarkdown(audit: SessionAudit): string {
  const { meta, filesChanged, totals } = audit;
  const title = sessionTitleFromAudit(audit);
  const lines: string[] = [];

  lines.push(`# Session Audit — ${title}`);
  lines.push("");
  lines.push(`- ID: ${meta.id}`);
  if (meta.task.trim()) lines.push(`- Task: ${compactTruncate(meta.task, 200)}`);
  if (meta.mode) lines.push(`- Mode: ${meta.mode}`);
  if (meta.status) lines.push(`- Status: ${meta.status}`);
  if (meta.createdAt || meta.updatedAt) lines.push(`- Time: ${meta.createdAt || "?"} → ${meta.updatedAt || "?"}`);
  lines.push(
    `- Totals: ${totals.userTurns} user turn(s), ${totals.assistantMessages} assistant message(s), ` +
      `${totals.toolCalls} tool call(s), ${totals.filesChanged} file(s) changed`,
  );
  lines.push(
    `- Tokens: ${totals.tokens.prompt} prompt, ${totals.tokens.completion} completion, ` +
      `${totals.tokens.cacheHit} cache-hit — cost $${totals.costUsd.toFixed(4)}`,
  );
  lines.push("");

  lines.push("## Files changed");
  if (filesChanged.length === 0) {
    lines.push("- (none)");
  } else {
    for (const f of filesChanged) {
      const kind = f.created ? "created" : "modified";
      const turns = f.turns.length > 0 ? ` — turn(s) ${f.turns.join(", ")}` : "";
      lines.push(`- \`${f.path}\` (${kind})${turns}`);
    }
  }
  lines.push("");

  lines.push("## Timeline");
  if (audit.turns.length === 0) {
    lines.push("- (no turns recorded)");
  } else {
    for (const turn of audit.turns) {
      lines.push("");
      lines.push(`### Turn ${turn.index}`);
      lines.push(`- Prompt: ${compactTruncate(turn.user, 200) || "(none)"}`);
      lines.push(`- Assistant: ${compactTruncate(turn.assistant, 200) || "(no text)"}`);
      for (const call of turn.toolCalls) {
        // null = no result recorded (interrupted); distinct from success/failure.
        const mark = call.ok === null ? "?" : call.ok ? "✓" : "✗";
        const suffix = call.ok === null ? " — no result recorded" : "";
        lines.push(`  - ${mark} ${call.name}(${call.argsSummary})${suffix}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Header title: prefer the meta task's first line, else the id. */
function sessionTitleFromAudit(audit: SessionAudit): string {
  const first = audit.meta.task
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "");
  return first ? first.slice(0, 80) : audit.meta.id;
}
