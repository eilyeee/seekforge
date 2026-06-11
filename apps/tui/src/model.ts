import type {
  AgentEvent,
  FinalReport,
  PermissionRequest,
  TokenUsage,
} from "@seekforge/shared";

/**
 * The chat model. A flat list of renderable items plus session-level state
 * (status bar inputs). The reducer below is a pure port of the CLI renderer's
 * event→display switch, producing items instead of writing to stdout.
 */

export type PlanStatus = "pending" | "in_progress" | "done";
export type PlanItem = { step: string; status: PlanStatus };

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "step"; id: string; title: string }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      args: unknown;
      status: "running" | "ok" | "error";
      error?: { code: string; message: string };
    }
  | { kind: "plan"; id: string; items: PlanItem[] }
  | { kind: "file"; id: string; path: string }
  | { kind: "notice"; id: string; text: string; tone: "dim" | "error" }
  | { kind: "report"; id: string; report: FinalReport };

export type ContextUsage = { usedTokens: number; budgetTokens: number; percent: number };

export type ChatState = {
  items: ChatItem[];
  /** running | idle — drives the spinner. */
  running: boolean;
  model: string;
  /** Latest context-window occupancy from context.usage events. */
  context?: ContextUsage;
  /** Cumulative usage across all turns this session (cost + tokens). */
  totalUsage: TokenUsage;
  /** Active session id (resume chaining like the REPL). */
  sessionId?: string;
  /** Pending permission request awaiting a y/n keypress, if any. */
  permission?: PermissionRequest;
};

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function initialState(model: string): ChatState {
  return {
    items: [],
    running: false,
    model,
    totalUsage: emptyUsage(),
  };
}

export type ChatAction =
  | { type: "user"; text: string }
  | { type: "notice"; text: string; tone?: "dim" | "error" }
  | { type: "model-delta"; chunk: string }
  | { type: "run-start" }
  | { type: "run-end" }
  | { type: "set-model"; model: string }
  | { type: "new-session" }
  | { type: "set-session"; sessionId: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission-resolved" }
  | { type: "event"; event: AgentEvent };

let counter = 0;
/** Monotonic id for keying React items. */
export function nextId(prefix = "i"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function lastItem(items: ChatItem[]): ChatItem | undefined {
  return items[items.length - 1];
}

/** Pure reducer: a port of apps/cli/src/render.ts's switch into item state. */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "user":
      return { ...state, items: [...state.items, { kind: "user", id: nextId("u"), text: action.text }] };

    case "notice":
      return {
        ...state,
        items: [...state.items, { kind: "notice", id: nextId("n"), text: action.text, tone: action.tone ?? "dim" }],
      };

    case "model-delta": {
      // Coalesce streamed deltas into the trailing streaming assistant item;
      // open a new one if the last item is not a live assistant turn.
      const last = lastItem(state.items);
      if (last && last.kind === "assistant" && last.streaming) {
        const updated: ChatItem = { ...last, text: last.text + action.chunk };
        return { ...state, items: [...state.items.slice(0, -1), updated] };
      }
      return {
        ...state,
        items: [...state.items, { kind: "assistant", id: nextId("a"), text: action.chunk, streaming: true }],
      };
    }

    case "run-start":
      return { ...state, running: true };

    case "run-end": {
      // Close any open streaming assistant item.
      const items = state.items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      );
      return { ...state, running: false, items };
    }

    case "set-model":
      return { ...state, model: action.model };

    case "new-session":
      return { ...state, sessionId: undefined };

    case "set-session":
      return { ...state, sessionId: action.sessionId };

    case "permission":
      return { ...state, permission: action.request };

    case "permission-resolved":
      return { ...state, permission: undefined };

    case "event":
      return applyEvent(state, action.event);

    default:
      return state;
  }
}

/** The event→item mapping (mirrors renderEvent in apps/cli/src/render.ts). */
function applyEvent(state: ChatState, e: AgentEvent): ChatState {
  switch (e.type) {
    case "session.created":
      return { ...state, sessionId: e.sessionId };

    case "step.started":
      return { ...state, items: [...state.items, { kind: "step", id: nextId("s"), title: e.title }] };

    case "model.message": {
      // Content already streamed via onModelDelta; close the live item. If we
      // never streamed (no delta), materialize the full content now.
      const last = lastItem(state.items);
      if (last && last.kind === "assistant" && last.streaming) {
        return {
          ...state,
          items: [...state.items.slice(0, -1), { ...last, streaming: false }],
        };
      }
      if (e.content.trim() === "") return state;
      return {
        ...state,
        items: [...state.items, { kind: "assistant", id: nextId("a"), text: e.content, streaming: false }],
      };
    }

    case "tool.started":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "tool", id: nextId("t"), toolName: e.toolName, args: e.args, status: "running" },
        ],
      };

    case "tool.completed": {
      // update_plan renders as an in-place plan card (upsert), not a tool row.
      if (e.toolName === "update_plan" && e.result.ok) {
        const planItems = (e.result.data as { items?: PlanItem[] })?.items ?? [];
        // Drop the matching running tool row first (the plan card replaces it).
        const items = dropLastRunningTool(state.items, "update_plan");
        const existingPlanIdx = items.findIndex((it) => it.kind === "plan");
        if (existingPlanIdx >= 0) {
          const next = items.slice();
          next[existingPlanIdx] = { ...(items[existingPlanIdx] as ChatItem & { kind: "plan" }), items: planItems };
          return { ...state, items: next };
        }
        return { ...state, items: [...items, { kind: "plan", id: nextId("p"), items: planItems }] };
      }
      // Pair the completion with the most recent running tool row of this name.
      const idx = lastRunningToolIndex(state.items, e.toolName);
      if (idx < 0) return state;
      const next = state.items.slice();
      const row = next[idx] as ChatItem & { kind: "tool" };
      next[idx] = {
        ...row,
        status: e.result.ok ? "ok" : "error",
        error: e.result.ok ? undefined : { code: e.result.error?.code ?? "error", message: e.result.error?.message ?? "" },
      };
      return { ...state, items: next };
    }

    case "file.changed":
      return { ...state, items: [...state.items, { kind: "file", id: nextId("f"), path: e.path }] };

    case "context.compacted":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: nextId("n"), tone: "dim", text: `context compacted: dropped ${e.droppedTurns} earlier messages` },
        ],
      };

    case "context.usage":
      return { ...state, context: { usedTokens: e.usedTokens, budgetTokens: e.budgetTokens, percent: e.percent } };

    case "usage.updated":
      // usage.updated is incremental within a turn; cumulative total is taken
      // from session.completed to avoid double counting.
      return state;

    case "session.completed":
      return {
        ...state,
        totalUsage: addUsage(state.totalUsage, e.report.usage),
        items: [...state.items, { kind: "report", id: nextId("r"), report: e.report }],
      };

    case "session.failed":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: nextId("n"), tone: "error", text: `failed: ${e.error.code} — ${e.error.message}` },
        ],
      };

    default:
      return state; // command.output / step.completed: silent for now
  }
}

function lastRunningToolIndex(items: ChatItem[], toolName: string): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it && it.kind === "tool" && it.toolName === toolName && it.status === "running") return i;
  }
  return -1;
}

function dropLastRunningTool(items: ChatItem[], toolName: string): ChatItem[] {
  const idx = lastRunningToolIndex(items, toolName);
  if (idx < 0) return items;
  return [...items.slice(0, idx), ...items.slice(idx + 1)];
}
