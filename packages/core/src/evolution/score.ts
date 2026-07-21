/**
 * scoreSession: heuristic 0-100 quality score for a finished session,
 * computed from the session trace files only (no model call).
 *
 * Reads .seekforge/sessions/<id>/{session.json,messages.jsonl,tool-calls.jsonl}.
 */

import type { SessionStatus } from "@seekforge/shared";
import { readSessionMeta } from "../agent/index.js";
import { readSessionText } from "../agent/trace.js";

export type SessionScoreMetrics = {
  /** Assistant turns (model responses) in the transcript. */
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  /** run_command invocations whose exact command was already run before. */
  retriedCommands: number;
  costUsd: number;
  /** A test/lint/build/typecheck command was run during the session. */
  verificationRan: boolean;
  status: SessionStatus;
};

export type SessionScore = {
  sessionId: string;
  /** 0-100, higher is better. */
  score: number;
  metrics: SessionScoreMetrics;
  /** One line per deduction, explaining the score. */
  notes: string[];
};

const FAILED_TOOL_CALL_PENALTY = 3;
const FAILED_TOOL_CALL_CAP = 30;
const FAILED_STATUS_PENALTY = 25;
const NO_VERIFICATION_PENALTY = 15;
const FREE_TURNS = 10;
const EXTRA_TURN_CAP = 15;

const VERIFICATION_COMMAND_RE = /\b(test|lint|build|typecheck|tsc|vitest|check)\b/i;

type ToolCallEntry = {
  toolName?: string;
  ok?: boolean;
  errorCode?: string | null;
  args?: Record<string, unknown>;
};

function readJsonlObjects(workspace: string, sessionId: string, name: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readSessionText(workspace, sessionId, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  const objects: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Corrupt line: tolerate and skip.
    }
  }
  return objects;
}

export function readToolCallLog(workspace: string, sessionId: string): ToolCallEntry[] {
  return readJsonlObjects(workspace, sessionId, "tool-calls.jsonl") as ToolCallEntry[];
}

function commandOf(entry: ToolCallEntry): string | undefined {
  if (entry.toolName !== "run_command") return undefined;
  const command = entry.args?.command;
  return typeof command === "string" ? command : undefined;
}

export function scoreSession(workspace: string, sessionId: string): SessionScore {
  const meta = readSessionMeta(workspace, sessionId);
  if (!meta) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const messages = readJsonlObjects(workspace, sessionId, "messages.jsonl");
  const toolCalls = readToolCallLog(workspace, sessionId);

  const turns = messages.filter((m) => m.role === "assistant").length;
  const failedToolCalls = toolCalls.filter((t) => t.ok === false).length;

  let retriedCommands = 0;
  const seenCommands = new Set<string>();
  let verificationRan = false;
  for (const entry of toolCalls) {
    const command = commandOf(entry);
    if (command === undefined) continue;
    if (seenCommands.has(command)) retriedCommands++;
    seenCommands.add(command);
    if (VERIFICATION_COMMAND_RE.test(command)) verificationRan = true;
  }

  const metrics: SessionScoreMetrics = {
    turns,
    toolCalls: toolCalls.length,
    failedToolCalls,
    retriedCommands,
    costUsd: meta.usage?.costUsd ?? 0,
    verificationRan,
    status: meta.status,
  };

  let score = 100;
  const notes: string[] = [];

  if (meta.status === "failed" || meta.status === "cancelled") {
    score -= FAILED_STATUS_PENALTY;
    notes.push(`session status is ${meta.status}: -${FAILED_STATUS_PENALTY}`);
  }
  if (failedToolCalls > 0) {
    const penalty = Math.min(FAILED_TOOL_CALL_CAP, failedToolCalls * FAILED_TOOL_CALL_PENALTY);
    score -= penalty;
    notes.push(`${failedToolCalls} failed tool call(s): -${penalty}`);
  }
  if (meta.mode === "edit" && !verificationRan) {
    score -= NO_VERIFICATION_PENALTY;
    notes.push(`edit session ran no test/lint/build command: -${NO_VERIFICATION_PENALTY}`);
  }
  if (turns > FREE_TURNS) {
    const penalty = Math.min(EXTRA_TURN_CAP, turns - FREE_TURNS);
    score -= penalty;
    notes.push(`${turns} turns (over ${FREE_TURNS}): -${penalty}`);
  }

  score = Math.min(100, Math.max(0, score));
  return { sessionId, score, metrics, notes };
}
