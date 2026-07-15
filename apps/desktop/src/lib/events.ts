/**
 * Pure chat-state reducer: turns the server event stream into renderable
 * chat items. No DOM, no store — unit-tested in events.test.ts.
 */
import type { AgentError, AgentEvent, FinalReport, SubagentStatus, TokenUsage, ToolResult } from "@seekforge/shared";
import { validateTeamPlan, type TeamMemberPlan } from "./team";
import { addUsage, emptyUsage } from "./usage";

/** update_plan checklist item (mirrors @seekforge/core tools/builtins/plan.ts). */
export type PlanItem = { step: string; status: "pending" | "in_progress" | "done" };

/**
 * Everything the WS delivers inside {"type":"event"} frames: every AgentEvent
 * plus the server-level model.delta / reasoning.delta streaming events
 * (see SERVER-API.md).
 */
export type StreamEvent =
  | AgentEvent
  | { type: "model.delta"; chunk: string }
  | { type: "reasoning.delta"; chunk: string };

/** Max live-output lines kept on a running command row (command.output). */
export const COMMAND_TAIL_LINES = 5;
export const SUBAGENT_STEP_LIMIT = 50;

export type ChatItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; streaming: boolean }
  /** Streamed chain-of-thought; collapsed in the UI once streaming ends. */
  | { kind: "thinking"; id: number; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: number;
      name: string;
      args: unknown;
      status: "running" | "ok" | "error";
      result?: ToolResult;
      /** Live output while running, capped to the last COMMAND_TAIL_LINES lines. */
      tail?: string;
    }
  | { kind: "plan"; id: number; items: PlanItem[] }
  | { kind: "substep"; id: number; agentId: string; steps: string[] }
  | {
      kind: "subagent";
      id: number;
      dispatchId: string;
      agentId: string;
      task: string;
      status: SubagentStatus;
      steps: string[];
      subSessionId?: string;
      resultSummary?: string;
      error?: { code: string; message: string };
      control?: { operation: "steer" | "cancel"; status: "accepted" };
    }
  | {
      kind: "team";
      id: number;
      status: "running" | "done" | "failed" | "cancelled";
      maxConcurrency: number;
      failurePolicy: "stop" | "continue";
      members: Array<TeamMemberPlan & {
        status: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
        dispatchId?: string;
        reason?: string;
      }>;
    }
  | { kind: "file"; id: number; path: string }
  | { kind: "compacted"; id: number; droppedTurns: number; summaryTokens: number }
  | { kind: "microcompacted"; id: number; clearedResults: number }
  /** A user-facing message from a hook (notice event / its systemMessage). */
  | { kind: "notice"; id: number; level: "info" | "warn"; message: string }
  | { kind: "report"; id: number; report: FinalReport }
  | { kind: "failed"; id: number; error: AgentError };

/** Latest context-window occupancy (context.usage event). */
export type ContextUsage = { usedTokens: number; budgetTokens: number; percent: number };

/** Transient provider-retry indicator (provider.retry events). */
export type RetryStatus = { attempt: number; maxAttempts: number; delayMs: number; reason: string };

export type ChatState = {
  items: ChatItem[];
  sessionId: string | null;
  running: boolean;
  /** Cumulative across session.completed reports. */
  usage: TokenUsage;
  /** Latest context.usage event; null until the first turn reports it. */
  contextUsage: ContextUsage | null;
  /**
   * Transient provider-retry status while the provider backs off; null
   * otherwise. Cleared on the next successful provider response
   * (usage.updated) or when the run ends. Rendered as a small inline notice,
   * never as a permanent transcript row.
   */
  retry: RetryStatus | null;
  nextId: number;
};

export function initialChatState(): ChatState {
  return {
    items: [],
    sessionId: null,
    running: false,
    usage: emptyUsage(),
    contextUsage: null,
    retry: null,
    nextId: 1,
  };
}

/** Distributive Omit so each union member loses `id` individually. */
export type NewChatItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, "id"> : never) : never;

function push(state: ChatState, item: NewChatItem): ChatState {
  return {
    ...state,
    items: [...state.items, { ...item, id: state.nextId } as ChatItem],
    nextId: state.nextId + 1,
  };
}

function findLastIndex(items: ChatItem[], pred: (i: ChatItem) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) return i;
  }
  return -1;
}

export function appendUser(state: ChatState, text: string): ChatState {
  return push(state, { kind: "user", text });
}

/** Extract validated plan items out of an update_plan tool result. */
export function planItemsFrom(value: unknown): PlanItem[] | null {
  if (typeof value !== "object" || value === null) return null;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  const out: PlanItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) return null;
    const { step, status } = raw as Record<string, unknown>;
    if (typeof step !== "string") return null;
    if (status !== "pending" && status !== "in_progress" && status !== "done") return null;
    out.push({ step, status });
  }
  return out;
}

/** The plan checklist updates in place: one plan item, replaced on each update. */
export function upsertPlan(state: ChatState, items: PlanItem[]): ChatState {
  const idx = findLastIndex(state.items, (i) => i.kind === "plan");
  if (idx >= 0) {
    const existing = state.items[idx]!;
    const next = [...state.items];
    next[idx] = { kind: "plan", id: existing.id, items };
    return { ...state, items: next };
  }
  return push(state, { kind: "plan", items });
}

/** Nested subagent activity arrives as step.started "[agentId] toolName". */
const SUBSTEP_RE = /^\[([a-z0-9-]+)\]\s+(.+)$/;

function activeSubagentIndex(items: ChatItem[], dispatchId: string): number {
  return findLastIndex(
    items,
    (item) => item.kind === "subagent" && item.dispatchId === dispatchId && item.status === "running",
  );
}

function activeTeamIndex(items: ChatItem[]): number {
  return findLastIndex(items, (item) => item.kind === "team" && item.status === "running");
}

function bindTeamDispatch(state: ChatState, event: Extract<AgentEvent, { type: "subagent.started" }>): ChatState {
  const index = activeTeamIndex(state.items);
  if (index < 0) return state;
  const team = state.items[index] as Extract<ChatItem, { kind: "team" }>;
  const memberIndex = team.members.findIndex(
    (member) => member.status === "pending" && member.agentId === event.agentId && member.task === event.task,
  );
  if (memberIndex < 0) return state;
  const members = [...team.members];
  members[memberIndex] = { ...members[memberIndex]!, status: "running", dispatchId: event.dispatchId };
  const items = [...state.items];
  items[index] = { ...team, members };
  return { ...state, items };
}

function updateTeamDispatch(
  state: ChatState,
  event: Extract<AgentEvent, { type: "subagent.completed" | "subagent.failed" | "subagent.cancelled" }>,
): ChatState {
  const index = activeTeamIndex(state.items);
  if (index < 0) return state;
  const team = state.items[index] as Extract<ChatItem, { kind: "team" }>;
  const memberIndex = team.members.findIndex((member) => member.dispatchId === event.dispatchId);
  if (memberIndex < 0) return state;
  const members = [...team.members];
  members[memberIndex] = {
    ...members[memberIndex]!,
    status: event.status,
    ...(event.type === "subagent.cancelled" ? { reason: event.reason } : {}),
    ...(event.type === "subagent.failed" ? { reason: event.error.message } : {}),
  };
  const items = [...state.items];
  items[index] = { ...team, members };
  return { ...state, items };
}

export function acknowledgeSubagentControl(
  state: ChatState,
  dispatchId: string,
  operation: "steer" | "cancel",
): ChatState {
  const index = activeSubagentIndex(state.items, dispatchId);
  if (index < 0) return state;
  const item = state.items[index] as Extract<ChatItem, { kind: "subagent" }>;
  const items = [...state.items];
  items[index] = { ...item, control: { operation, status: "accepted" } };
  return { ...state, items };
}

/** Ends the streaming thinking block (any later event = the answer started). */
function finishThinking(state: ChatState): ChatState {
  const idx = findLastIndex(state.items, (i) => i.kind === "thinking" && i.streaming);
  if (idx < 0) return state;
  const thinking = state.items[idx] as Extract<ChatItem, { kind: "thinking" }>;
  const next = [...state.items];
  next[idx] = { ...thinking, streaming: false };
  return { ...state, items: next };
}

export function reduceEvent(state: ChatState, ev: StreamEvent): ChatState {
  // Reasoning streams strictly before the answer/tool calls of a turn, so any
  // other event closes (collapses) the open thinking block.
  if (ev.type !== "reasoning.delta") state = finishThinking(state);
  switch (ev.type) {
    case "reasoning.delta": {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "thinking" && last.streaming) {
        const next = [...state.items];
        next[next.length - 1] = { ...last, text: last.text + ev.chunk };
        return { ...state, items: next };
      }
      return push(state, { kind: "thinking", text: ev.chunk, streaming: true });
    }

    case "session.created":
      return { ...state, sessionId: ev.sessionId };

    case "step.started": {
      const m = SUBSTEP_RE.exec(ev.title);
      if (!m) return state;
      const [, agentId, toolName] = m as unknown as [string, string, string];
      if (state.items.some((item) => item.kind === "subagent" && item.agentId === agentId && item.status === "running")) {
        return state;
      }
      // Accumulate consecutive steps of the same agent into one card.
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "substep" && last.agentId === agentId) {
        const next = [...state.items];
        next[next.length - 1] = { ...last, steps: [...last.steps, toolName] };
        return { ...state, items: next };
      }
      return push(state, { kind: "substep", agentId, steps: [toolName] });
    }

    case "subagent.started":
      state = bindTeamDispatch(state, ev);
      return push(state, {
        kind: "subagent",
        dispatchId: ev.dispatchId,
        agentId: ev.agentId,
        task: ev.task,
        status: "running",
        steps: [],
      });

    case "subagent.step": {
      const idx = activeSubagentIndex(state.items, ev.dispatchId);
      if (idx < 0) {
        return push(state, {
          kind: "subagent",
          dispatchId: ev.dispatchId,
          agentId: ev.agentId,
          task: ev.task,
          status: "running",
          steps: [ev.toolName],
          ...(ev.subSessionId ? { subSessionId: ev.subSessionId } : {}),
        });
      }
      const item = state.items[idx] as Extract<ChatItem, { kind: "subagent" }>;
      const items = [...state.items];
      items[idx] = {
        ...item,
        steps: [...item.steps, ev.toolName].slice(-SUBAGENT_STEP_LIMIT),
        ...(ev.subSessionId ? { subSessionId: ev.subSessionId } : {}),
      };
      return { ...state, items };
    }

    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled": {
      state = updateTeamDispatch(state, ev);
      const idx = activeSubagentIndex(state.items, ev.dispatchId);
      const base: Omit<Extract<ChatItem, { kind: "subagent" }>, "id"> = {
        kind: "subagent",
        dispatchId: ev.dispatchId,
        agentId: ev.agentId,
        task: ev.task,
        status: ev.status,
        steps: idx >= 0
          ? (state.items[idx] as Extract<ChatItem, { kind: "subagent" }>).steps
          : [],
        ...(ev.subSessionId ? { subSessionId: ev.subSessionId } : {}),
        ...(ev.type === "subagent.cancelled"
          ? { resultSummary: ev.reason }
          : { resultSummary: ev.resultSummary }),
        ...(ev.type === "subagent.failed" ? { error: ev.error } : {}),
      };
      if (idx < 0) return push(state, base);
      const items = [...state.items];
      items[idx] = { ...base, id: state.items[idx]!.id };
      return { ...state, items };
    }

    case "model.delta": {
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const next = [...state.items];
        next[next.length - 1] = { ...last, text: last.text + ev.chunk };
        return { ...state, items: next };
      }
      return push(state, { kind: "assistant", text: ev.chunk, streaming: true });
    }

    case "model.message": {
      // Replace the streamed deltas with the final, authoritative text.
      const idx = findLastIndex(state.items, (i) => i.kind === "assistant" && i.streaming);
      if (idx >= 0) {
        const next = [...state.items];
        next[idx] = { kind: "assistant", id: next[idx]!.id, text: ev.content, streaming: false };
        return { ...state, items: next };
      }
      if (!ev.content) return state;
      return push(state, { kind: "assistant", text: ev.content, streaming: false });
    }

    case "tool.started": {
      // update_plan renders as the plan checklist, not as a tool row.
      if (ev.toolName === "update_plan") return state;
      if (ev.toolName === "dispatch_team") {
        const validated = validateTeamPlan(ev.args);
        if (!validated.ok) return state;
        return push(state, {
          kind: "team",
          status: "running",
          maxConcurrency: validated.plan.maxConcurrency,
          failurePolicy: validated.plan.failurePolicy,
          members: validated.plan.members.map((member) => ({ ...member, status: "pending" })),
        });
      }
      return push(state, { kind: "tool", name: ev.toolName, args: ev.args, status: "running" });
    }

    case "tool.completed": {
      if (ev.toolName === "update_plan") {
        const items = ev.result.ok ? planItemsFrom(ev.result.data) : null;
        return items ? upsertPlan(state, items) : state;
      }
      if (ev.toolName === "dispatch_team") {
        const index = activeTeamIndex(state.items);
        if (index < 0) return state;
        const team = state.items[index] as Extract<ChatItem, { kind: "team" }>;
        const data = ev.result.data;
        const record = typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
        const outcomes = Array.isArray(record?.members) ? record.members : [];
        const byId = new Map<string, Record<string, unknown>>();
        for (const outcome of outcomes) {
          if (typeof outcome === "object" && outcome !== null && !Array.isArray(outcome) && typeof (outcome as { id?: unknown }).id === "string") {
            byId.set((outcome as { id: string }).id, outcome as Record<string, unknown>);
          }
        }
        const statuses = new Set(["pending", "running", "done", "failed", "cancelled", "skipped"]);
        const members = team.members.map((member) => {
          const outcome = byId.get(member.id);
          const status = outcome && typeof outcome.status === "string" && statuses.has(outcome.status)
            ? outcome.status as typeof member.status
            : member.status;
          return { ...member, status, ...(typeof outcome?.reason === "string" ? { reason: outcome.reason } : {}) };
        });
        const reportedStatus = record?.status;
        const status = reportedStatus === "done" || reportedStatus === "failed" || reportedStatus === "cancelled"
          ? reportedStatus
          : ev.result.ok ? "done" : "failed";
        const items = [...state.items];
        items[index] = { ...team, status, members };
        return { ...state, items };
      }
      const status = ev.result.ok ? "ok" : "error";
      const idx = findLastIndex(
        state.items,
        (i) => i.kind === "tool" && i.name === ev.toolName && i.status === "running",
      );
      if (idx >= 0) {
        const running = state.items[idx] as Extract<ChatItem, { kind: "tool" }>;
        const next = [...state.items];
        // The live tail is dropped: the result carries the full output now.
        next[idx] = { ...running, status, result: ev.result, tail: undefined };
        return { ...state, items: next };
      }
      return push(state, { kind: "tool", name: ev.toolName, args: undefined, status, result: ev.result });
    }

    // Live output of the running command: keep only the last few lines.
    case "command.output": {
      const idx = findLastIndex(state.items, (i) => i.kind === "tool" && i.status === "running");
      if (idx < 0) return state;
      const running = state.items[idx] as Extract<ChatItem, { kind: "tool" }>;
      // Chunks may end mid-line: concatenate raw, then cap by line count.
      const lines = `${running.tail ?? ""}${ev.chunk}`.split("\n");
      const next = [...state.items];
      next[idx] = { ...running, tail: lines.slice(-COMMAND_TAIL_LINES).join("\n") };
      return { ...state, items: next };
    }

    case "file.changed":
      return push(state, { kind: "file", path: ev.path });

    case "context.compacted":
      return push(state, {
        kind: "compacted",
        droppedTurns: ev.droppedTurns,
        summaryTokens: ev.summaryTokens,
      });

    case "context.microcompacted":
      return push(state, { kind: "microcompacted", clearedResults: ev.clearedResults });

    case "notice":
      return push(state, { kind: "notice", level: ev.level, message: ev.message });

    // No chat row: the footer renders the latest occupancy.
    case "context.usage":
      return {
        ...state,
        contextUsage: { usedTokens: ev.usedTokens, budgetTokens: ev.budgetTokens, percent: ev.percent },
      };

    // Transient retry indicator (no chat row): the footer renders it while the
    // provider backs off; the next successful turn (usage.updated) clears it.
    case "provider.retry":
      return {
        ...state,
        retry: {
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
        },
      };

    case "usage.updated":
      // A successful provider response clears any pending retry indicator.
      return state.retry ? { ...state, retry: null } : state;

    case "session.completed": {
      const next = push(state, { kind: "report", report: ev.report });
      return { ...next, usage: addUsage(state.usage, ev.report.usage), running: false, retry: null };
    }

    case "session.failed": {
      const next = push(state, { kind: "failed", error: ev.error });
      return { ...next, running: false, retry: null };
    }

    // permission.required is delivered via the dedicated permission.request
    // frame; step.* and usage.updated have no row of their own.
    default:
      return state;
  }
}
