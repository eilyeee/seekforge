import { existsSync } from "node:fs";
import { join } from "node:path";
import { listSessions, loadSessionMessages, readSessionMeta, sessionTitle } from "@seekforge/core";
import type { AgentEvent, ChatMessage } from "@seekforge/shared";
import { dim, fail } from "../colors.js";
import { t } from "../i18n.js";
import { createRenderer } from "../render.js";
import { MAX_REPLAY_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";

export type ReplayOptions = {
  /** Print full tool args and tool result data (mirrors run's --verbose). */
  verbose?: boolean;
};

/** Path to a session's persisted event stream (events.jsonl). */
function eventsFile(workspace: string, sessionId: string): string {
  return join(workspace, ".seekforge", "sessions", sessionId, "events.jsonl");
}

/**
 * Reads a session's events.jsonl back into AgentEvent[]. Each line is the event
 * object the trace wrote, prefixed with a `ts` field (createSessionTrace.event);
 * we strip `ts` and keep the AgentEvent. Blank/corrupt lines are skipped so a
 * partially-flushed trace still replays.
 */
export function loadSessionEvents(workspace: string, sessionId: string): AgentEvent[] {
  const file = eventsFile(workspace, sessionId);
  const events: AgentEvent[] = [];
  for (const line of readTextFileBounded(file, MAX_REPLAY_FILE_BYTES).split("\n")) {
    if (!line.trim()) continue;
    try {
      const { ts: _ts, ...event } = JSON.parse(line) as AgentEvent & { ts?: string };
      events.push(event as AgentEvent);
    } catch {
      // corrupt line: skip, keep the rest replayable
    }
  }
  return events;
}

/** Renders a stored message transcript when no event stream was persisted. */
function renderTranscript(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (m.role === "system") continue; // chrome, not part of the visible run
    const label =
      m.role === "user"
        ? t("cmd.replay.userLabel")
        : m.role === "assistant"
          ? t("cmd.replay.assistantLabel")
          : t("cmd.replay.toolLabel");
    console.log(dim(label));
    if (m.content.trim()) console.log(`${m.content}\n`);
    for (const call of m.toolCalls ?? []) {
      console.log(dim(`  → ${call.name} ${call.argumentsJson}`));
    }
  }
}

/**
 * Deterministically re-renders a stored session to the terminal — no model
 * calls, no network. Resolves the session in the cwd project; replays the
 * recorded AgentEvent stream through the same renderer a live run uses when
 * events.jsonl exists, otherwise falls back to the message transcript. Errors
 * clearly when the id is unknown.
 */
export function replayCommand(sessionId: string, opts: ReplayOptions = {}): void {
  const workspace = process.cwd();

  const meta = readSessionMeta(workspace, sessionId);
  if (!meta) {
    const known = listSessions(workspace, { includeSubagents: true })
      .slice(0, 5)
      .map((s) => s.id);
    const hint = known.length > 0 ? t("err.replayUnknownHint", { ids: known.join(", ") }) : t("err.replayNoSessions");
    fail(t("err.replayUnknown", { id: sessionId }), { hint });
    return;
  }

  console.log(dim(t("cmd.replay.header", { id: sessionId, title: sessionTitle(workspace, sessionId) })));

  if (existsSync(eventsFile(workspace, sessionId))) {
    const events = loadSessionEvents(workspace, sessionId);
    // streaming:false so model.message events print their full content (replay
    // has no live deltas to have already streamed).
    const renderer = createRenderer({ streaming: false, verbose: opts.verbose });
    for (const e of events) renderer.render(e);
    return;
  }

  // No event stream (older trace, or run that never emitted events): fall back
  // to the recorded conversation.
  let messages: ChatMessage[];
  try {
    messages = loadSessionMessages(workspace, sessionId);
  } catch {
    console.log(t("cmd.replay.empty"));
    return;
  }
  renderTranscript(messages);
}
