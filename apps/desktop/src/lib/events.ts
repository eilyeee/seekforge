/**
 * Pure chat-state reducer: turns the server event stream into renderable
 * chat items. No DOM, no store — unit-tested in events.test.ts.
 */
import type { AgentError, AgentEvent, FinalReport, TokenUsage, ToolResult } from "@seekforge/shared";
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
  | { kind: "file"; id: number; path: string }
  | { kind: "compacted"; id: number; droppedTurns: number; summaryTokens: number }
  | { kind: "microcompacted"; id: number; clearedResults: number }
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
      // Accumulate consecutive steps of the same agent into one card.
      const last = state.items[state.items.length - 1];
      if (last && last.kind === "substep" && last.agentId === agentId) {
        const next = [...state.items];
        next[next.length - 1] = { ...last, steps: [...last.steps, toolName] };
        return { ...state, items: next };
      }
      return push(state, { kind: "substep", agentId, steps: [toolName] });
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
      return push(state, { kind: "tool", name: ev.toolName, args: ev.args, status: "running" });
    }

    case "tool.completed": {
      if (ev.toolName === "update_plan") {
        const items = ev.result.ok ? planItemsFrom(ev.result.data) : null;
        return items ? upsertPlan(state, items) : state;
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
