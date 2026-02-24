import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ChatMessage, SessionStatus, TokenUsage } from "@seekforge/shared";

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

/** All sessions of a workspace, newest first. */
export function listSessions(workspace: string): SessionMeta[] {
  const root = sessionsRoot(workspace);
  if (!existsSync(root)) return [];
  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readSessionMeta(workspace, entry.name);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}
