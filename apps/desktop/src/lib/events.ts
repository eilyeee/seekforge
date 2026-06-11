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
 * plus the server-level model.delta streaming event (see SERVER-API.md).
 */
export type StreamEvent = AgentEvent | { type: "model.delta"; chunk: string };

export type ChatItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: number;
      name: string;
      args: unknown;
      status: "running" | "ok" | "error";
      result?: ToolResult;
    }
  | { kind: "plan"; id: number; items: PlanItem[] }
  | { kind: "substep"; id: number; agentId: string; steps: string[] }
  | { kind: "file"; id: number; path: string }
  | { kind: "compacted"; id: number; droppedTurns: number; summaryTokens: number }
  | { kind: "report"; id: number; report: FinalReport }
  | { kind: "failed"; id: number; error: AgentError };

export type ChatState = {
  items: ChatItem[];
  sessionId: string | null;
  running: boolean;
  /** Cumulative across session.completed reports. */
  usage: TokenUsage;
  nextId: number;
};

export function initialChatState(): ChatState {
  return { items: [], sessionId: null, running: false, usage: emptyUsage(), nextId: 1 };
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

export function reduceEvent(state: ChatState, ev: StreamEvent): ChatState {
  switch (ev.type) {
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
        next[idx] = { ...running, status, result: ev.result };
        return { ...state, items: next };
      }
      return push(state, { kind: "tool", name: ev.toolName, args: undefined, status, result: ev.result });
    }

    case "file.changed":
      return push(state, { kind: "file", path: ev.path });

    case "context.compacted":
      return push(state, {
        kind: "compacted",
        droppedTurns: ev.droppedTurns,
        summaryTokens: ev.summaryTokens,
      });

    case "session.completed": {
      const next = push(state, { kind: "report", report: ev.report });
      return { ...next, usage: addUsage(state.usage, ev.report.usage), running: false };
    }

    case "session.failed": {
      const next = push(state, { kind: "failed", error: ev.error });
      return { ...next, running: false };
    }

    // permission.required is delivered via the dedicated permission.request
    // frame; step.*, usage.updated and command.output have no row of their own.
    default:
      return state;
  }
}
