import type { AgentEvent, FinalReport, PermissionRequest, TokenUsage } from "@seekforge/shared";
import type { MemoryCandidate } from "@seekforge/core";
import type { CandidateScope } from "./memory-candidates.js";

/**
 * The chat model. A flat list of renderable items plus session-level state
 * (status bar inputs, overlay stack, scrollback offset, approval mode,
 * background tasks). The reducer below is a pure port of the CLI renderer's
 * event→display switch, producing items instead of writing to stdout.
 *
 * This file is the type hub for the TUI: every new surface is a reducer
 * field + a component, never ad-hoc state in components (DESIGN.md).
 */

export type PlanStatus = "pending" | "in_progress" | "done";
export type PlanItem = { step: string; status: PlanStatus };

/** Colored diff line kinds (mirrors apps/desktop/src/lib/diff.ts). */
export type DiffLineKind = "add" | "del" | "ctx" | "hunk";
export type DiffLine = { kind: DiffLineKind; text: string };

/** Background task surfaced from run_command background:true tool events. */
export type BgTaskStatus = "running" | "exited";
export type BgTask = { id: string; command: string; status: BgTaskStatus };

/** Persistent approval setting (Shift+Tab / /approve cycles these). */
export type ApprovalSetting = "auto" | "acceptEdits" | "confirm" | "plan";

/**
 * Overlay stack (top one receives keystrokes before the composer).
 * palette/files track their own selection index; query is derived from the
 * composer text by the app and pushed in via the "overlay" action.
 */
export type Overlay =
  | { kind: "palette"; query: string; index: number }
  | { kind: "files"; query: string; index: number; anchor: number }
  | { kind: "context" }
  /** Interactive session picker (/sessions): Enter resumes ids[index]. */
  | { kind: "sessions"; ids: string[]; lines: string[]; index: number }
  /** Backtrack picker (Esc Esc / /backtrack): Enter rewinds to the turn. */
  | {
      kind: "backtrack";
      targets: Array<{ turn: number; text: string; itemIndex: number }>;
      index: number;
    }
  /** Model picker (/model with no argument). */
  | { kind: "model"; ids: string[]; lines: string[]; index: number }
  /** Theme picker (/theme with no argument). */
  | { kind: "theme"; ids: string[]; lines: string[]; index: number }
  /**
   * Memory-candidate review (/memory candidates): a approves, r rejects, s
   * toggles the approve scope (project|user). `candidates` are pending only.
   */
  | { kind: "candidates"; candidates: MemoryCandidate[]; index: number; scope: CandidateScope }
  /** ask_user tool question awaiting an answer. */
  | { kind: "question"; question: string; options: string[]; index: number }
  /** Slash-argument picker ("/resume <cursor>"): Tab fills, Enter runs. */
  | {
      kind: "args";
      command: string;
      anchor: number;
      candidates: Array<{ value: string; hint?: string }>;
      index: number;
    }
  /** Grouped help overlay: Enter inserts the selected command. */
  | { kind: "help"; lines: string[]; selectable: number[]; names: string[]; index: number };

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  /** Chain-of-thought block (V4 thinking mode); collapsed unless verbose. */
  | { kind: "thinking"; id: string; text: string; streaming: boolean; startedAt: number; endedAt?: number }
  | { kind: "step"; id: string; title: string; agentId?: string }
  | {
      kind: "subagent";
      id: string;
      dispatchId: string;
      agentId: string;
      task: string;
      status: "running" | "done" | "failed" | "cancelled";
      subSessionId?: string;
      steps: string[];
      resultSummary?: string;
      error?: { code: string; message: string };
    }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      args: unknown;
      status: "running" | "ok" | "error";
      error?: { code: string; message: string };
      /** Trimmed result payload, shown in verbose mode (Ctrl+O). */
      resultPreview?: string;
      /** Rolling tail of live output while the command runs (last ~400 chars). */
      outputTail?: string;
    }
  | { kind: "plan"; id: string; items: PlanItem[] }
  | { kind: "file"; id: string; path: string }
  | { kind: "diff"; id: string; path: string; lines: DiffLine[] }
  /** Output of a "!" passthrough shell command. */
  | { kind: "shell"; id: string; command: string; output: string; exitCode: number }
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
  /** Pending permission request awaiting a y/a/n keypress, if any. */
  permission?: PermissionRequest;
  /** Top overlay, or null when keystrokes go to the composer. */
  overlay: Overlay | null;
  /**
   * Scrollback: number of items hidden BELOW the viewport (0 = pinned to
   * latest). Kept stable while new items arrive (the reducer bumps it).
   */
  scrollOffset: number;
  /** Persistent approval mode for subsequent runs. */
  approval: ApprovalSetting;
  /** A finished /plan run awaits the execute-or-keep decision. */
  planPending: boolean;
  /** Background tasks observed via tool events this session. */
  bgTasks: BgTask[];
  /** Messages typed while a run was active, sent in order afterwards. */
  queue: string[];
  /** Verbose rendering (Ctrl+O): full diffs, shell output, tool results. */
  verbose: boolean;
  /** Tasks detached to the background, keyed by run identity. */
  detached: { runId: number; label: string }[];
  /** Epoch ms when the current run started (drives the elapsed counter). */
  turnStartedAt?: number;
  /** Live token count for the current turn (from usage.updated events). */
  turnTokens: number;
  /**
   * Transient provider-retry indicator (provider.retry events). Shown in the
   * status bar while the provider backs off; cleared automatically on the next
   * successful provider response (usage.updated) or when the run ends, so it
   * never lingers and never spams the transcript.
   */
  retryStatus?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
};

/**
 * Approval-mode cycle for Shift+Tab / `/approve` (no arg): confirm →
 * acceptEdits → auto → plan → confirm. Pure so the order is unit-testable.
 */
export const APPROVAL_CYCLE: ApprovalSetting[] = ["confirm", "acceptEdits", "auto", "plan"];

/** The next mode after `current` in APPROVAL_CYCLE (wraps around). */
export function nextApproval(current: ApprovalSetting): ApprovalSetting {
  const idx = APPROVAL_CYCLE.indexOf(current);
  return APPROVAL_CYCLE[(idx + 1) % APPROVAL_CYCLE.length] ?? "confirm";
}

/** Maps a persistent approval setting to the run's core ApprovalMode. */
export function approvalModeFor(setting: ApprovalSetting): "auto" | "acceptEdits" | "confirm" {
  if (setting === "auto") return "auto";
  if (setting === "acceptEdits") return "acceptEdits";
  // "plan" runs read-only via the ask/plan path; its tools still confirm.
  return "confirm";
}

/**
 * Permission-panel keypress → core ConfirmResult. "y" allows once, "a" allows
 * this (and similar) for the rest of the session (the richer remember result
 * that grows CORE's session allowlist), anything else denies. Pure so the
 * return shape is unit-testable without rendering Ink.
 */
export function permissionResultForKey(key: string): boolean | { allow: true; remember: "session" } {
  const choice = key.toLowerCase();
  if (choice === "y") return true;
  if (choice === "a") return { allow: true, remember: "session" };
  return false;
}

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
    overlay: null,
    scrollOffset: 0,
    approval: "confirm",
    planPending: false,
    bgTasks: [],
    queue: [],
    verbose: false,
    detached: [],
    turnTokens: 0,
  };
}

export type ChatAction =
  | { type: "user"; text: string }
  | { type: "notice"; text: string; tone?: "dim" | "error" }
  | { type: "model-delta"; chunk: string }
  | { type: "thinking-delta"; chunk: string }
  | { type: "run-start" }
  | { type: "run-end" }
  | { type: "set-model"; model: string }
  | { type: "new-session" }
  | { type: "clear" }
  | { type: "set-session"; sessionId: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission-resolved" }
  | { type: "overlay"; overlay: Overlay | null }
  | { type: "overlay-move"; delta: number; count: number }
  | { type: "scroll"; delta: number; max: number }
  | { type: "scroll-latest" }
  | { type: "set-approval"; approval: ApprovalSetting }
  | { type: "plan-pending"; pending: boolean }
  | { type: "diff"; path: string; lines: DiffLine[] }
  | { type: "shell"; command: string; output: string; exitCode: number }
  | { type: "queue"; text: string }
  | { type: "dequeue" }
  | { type: "queue-clear" }
  /** Replaces bg-task state with a live snapshot from the shared manager. */
  | { type: "bg-sync"; tasks: BgTask[] }
  /** Conversation backtrack: drop the target user item and everything after. */
  | { type: "backtrack-apply"; itemIndex: number }
  | { type: "toggle-verbose" }
  /** Ctrl+B: the current run detaches; chat continues in a fresh session. */
  | { type: "run-detach"; runId: number; label: string }
  | { type: "run-detach-done"; runId: number }
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

/** Closes a trailing streaming thinking block (stamps its duration). */
function closeStreamingThinking(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "thinking" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false, endedAt: Date.now() }];
  }
  return items;
}

/** Matches nested-subagent step titles emitted by the loop: "[agentId] tool". */
const NESTED_STEP = /^\[([A-Za-z0-9_-]+)\] (.+)$/;
const SUBAGENT_STEP_LIMIT = 100;

function subagentIndex(items: ChatItem[], dispatchId: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "subagent" && item.dispatchId === dispatchId && item.status === "running") return index;
  }
  return -1;
}

/**
 * Pure reducer. Wraps the inner switch to keep the scrollback anchored: when
 * the user has scrolled up (offset > 0), newly appended items grow the offset
 * so the visible window does not shift underneath them.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  const next = innerReducer(state, action);
  if (state.scrollOffset > 0 && next.items.length > state.items.length) {
    return { ...next, scrollOffset: state.scrollOffset + (next.items.length - state.items.length) };
  }
  return next;
}

function innerReducer(state: ChatState, action: ChatAction): ChatState {
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
      // open a new one if the last item is not a live assistant turn. A
      // streaming thinking block is closed first (content follows thought).
      const closed = closeStreamingThinking(state.items);
      const last = lastItem(closed);
      if (last && last.kind === "assistant" && last.streaming) {
        const updated: ChatItem = { ...last, text: last.text + action.chunk };
        return { ...state, items: [...closed.slice(0, -1), updated] };
      }
      return {
        ...state,
        items: [...closed, { kind: "assistant", id: nextId("a"), text: action.chunk, streaming: true }],
      };
    }

    case "thinking-delta": {
      const last = lastItem(state.items);
      if (last && last.kind === "thinking" && last.streaming) {
        const updated: ChatItem = { ...last, text: last.text + action.chunk };
        return { ...state, items: [...state.items.slice(0, -1), updated] };
      }
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "thinking", id: nextId("th"), text: action.chunk, streaming: true, startedAt: Date.now() },
        ],
      };
    }

    case "run-start":
      return {
        ...state,
        running: true,
        scrollOffset: 0,
        turnStartedAt: Date.now(),
        turnTokens: 0,
        retryStatus: undefined,
      };

    case "run-end": {
      // Close any open streaming assistant/thinking items. Background tasks
      // live in the shared manager and survive the run.
      const items = state.items.map((it): ChatItem => {
        if (it.kind === "assistant" && it.streaming) return { ...it, streaming: false };
        if (it.kind === "thinking" && it.streaming) return { ...it, streaming: false, endedAt: Date.now() };
        return it;
      });
      return { ...state, running: false, items, retryStatus: undefined };
    }

    case "set-model":
      return { ...state, model: action.model };

    case "new-session":
      return { ...state, sessionId: undefined, planPending: false, bgTasks: [], queue: [] };

    case "clear":
      return {
        ...state,
        items: [],
        sessionId: undefined,
        planPending: false,
        bgTasks: [],
        queue: [],
        scrollOffset: 0,
        overlay: null,
      };

    case "set-session":
      return { ...state, sessionId: action.sessionId };

    case "permission":
      return { ...state, permission: action.request };

    case "permission-resolved":
      return { ...state, permission: undefined };

    case "overlay":
      return { ...state, overlay: action.overlay };

    case "overlay-move": {
      if (!state.overlay || state.overlay.kind === "context" || action.count <= 0) return state;
      const raw = state.overlay.index + action.delta;
      const index = ((raw % action.count) + action.count) % action.count; // wrap
      return { ...state, overlay: { ...state.overlay, index } };
    }

    case "scroll": {
      const max = Math.max(0, action.max);
      const offset = Math.min(max, Math.max(0, state.scrollOffset + action.delta));
      return { ...state, scrollOffset: offset };
    }

    case "scroll-latest":
      return { ...state, scrollOffset: 0 };

    case "set-approval":
      return { ...state, approval: action.approval };

    case "plan-pending":
      return { ...state, planPending: action.pending };

    case "diff":
      return {
        ...state,
        items: [...state.items, { kind: "diff", id: nextId("d"), path: action.path, lines: action.lines }],
      };

    case "shell":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "shell",
            id: nextId("sh"),
            command: action.command,
            output: action.output,
            exitCode: action.exitCode,
          },
        ],
      };

    case "queue":
      return { ...state, queue: [...state.queue, action.text] };

    case "dequeue":
      return { ...state, queue: state.queue.slice(1) };

    case "queue-clear":
      return { ...state, queue: [] };

    case "bg-sync":
      return { ...state, bgTasks: action.tasks };

    case "backtrack-apply":
      return {
        ...state,
        items: state.items.slice(0, Math.max(0, action.itemIndex)),
        overlay: null,
        scrollOffset: 0,
        planPending: false,
      };

    case "toggle-verbose":
      return { ...state, verbose: !state.verbose };

    case "run-detach": {
      // Detach means "this run goes background, I stop interacting with it in
      // the foreground". Any messages queued for the (now-detached) turn must
      // be dropped: keeping them would let the drain effect start an unrelated
      // fresh foreground session in this tab. Clear the queue and say so.
      const dropped = state.queue.length;
      const suffix = dropped > 0 ? `, ${dropped} queued message${dropped === 1 ? "" : "s"} discarded` : "";
      return {
        ...state,
        running: false,
        sessionId: undefined,
        queue: [],
        detached: [...state.detached, { runId: action.runId, label: action.label }],
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("n"),
            tone: "dim",
            text: `⚒ task continues in the background${suffix} — new messages start a fresh session`,
          },
        ],
      };
    }

    case "run-detach-done":
      return { ...state, detached: state.detached.filter((entry) => entry.runId !== action.runId) };

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

    case "step.started": {
      // Nested subagent activity is forwarded as "[agentId] tool" titles.
      const nested = NESTED_STEP.exec(e.title);
      // Structured subagent events create the thread row before legacy step
      // events arrive. Ignore that compatibility duplicate when possible.
      if (
        nested &&
        state.items.some((item) => item.kind === "subagent" && item.agentId === nested[1] && item.status === "running")
      ) {
        return state;
      }
      const step: ChatItem = nested
        ? { kind: "step", id: nextId("s"), title: nested[2] ?? e.title, agentId: nested[1] }
        : { kind: "step", id: nextId("s"), title: e.title };
      return { ...state, items: [...state.items, step] };
    }

    case "subagent.started": {
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "subagent",
            id: nextId("sa"),
            dispatchId: e.dispatchId,
            agentId: e.agentId,
            task: e.task,
            status: "running",
            steps: [],
          },
        ],
      };
    }

    case "subagent.step": {
      const idx = subagentIndex(state.items, e.dispatchId);
      if (idx < 0) {
        return {
          ...state,
          items: [
            ...state.items,
            {
              kind: "subagent",
              id: nextId("sa"),
              dispatchId: e.dispatchId,
              agentId: e.agentId,
              task: e.task,
              status: "running",
              ...(e.subSessionId !== undefined ? { subSessionId: e.subSessionId } : {}),
              steps: [e.toolName],
            },
          ],
        };
      }
      const items = state.items.slice();
      const prior = items[idx] as Extract<ChatItem, { kind: "subagent" }>;
      items[idx] = {
        ...prior,
        ...(e.subSessionId !== undefined ? { subSessionId: e.subSessionId } : {}),
        steps: [...prior.steps, e.toolName].slice(-SUBAGENT_STEP_LIMIT),
      };
      return { ...state, items };
    }

    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled": {
      const idx = subagentIndex(state.items, e.dispatchId);
      const existing = idx >= 0 ? (state.items[idx] as Extract<ChatItem, { kind: "subagent" }>) : undefined;
      const item: Extract<ChatItem, { kind: "subagent" }> = {
        kind: "subagent",
        id: existing?.id ?? nextId("sa"),
        dispatchId: e.dispatchId,
        agentId: e.agentId,
        task: e.task,
        status: e.status,
        steps: existing?.steps ?? [],
        ...(e.subSessionId !== undefined ? { subSessionId: e.subSessionId } : {}),
        ...(e.type === "subagent.completed" || e.type === "subagent.failed"
          ? { resultSummary: e.resultSummary }
          : { resultSummary: e.reason }),
        ...(e.type === "subagent.failed" ? { error: e.error } : {}),
      };
      if (idx < 0) return { ...state, items: [...state.items, item] };
      const items = state.items.slice();
      items[idx] = item;
      return { ...state, items };
    }

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
      if (idx < 0) return applyBgEvent(state, e.toolName, e.result.ok, e.result.data, undefined);
      const next = state.items.slice();
      const row = next[idx] as ChatItem & { kind: "tool" };
      const { outputTail: _tail, ...rest } = row; // live tail ends with the call
      next[idx] = {
        ...rest,
        status: e.result.ok ? "ok" : "error",
        error: e.result.ok
          ? undefined
          : { code: e.result.error?.code ?? "error", message: e.result.error?.message ?? "" },
        ...(e.result.ok && e.result.data !== undefined ? { resultPreview: previewData(e.result.data) } : {}),
      };
      return applyBgEvent({ ...state, items: next }, e.toolName, e.result.ok, e.result.data, row.args);
    }

    case "file.changed":
      return { ...state, items: [...state.items, { kind: "file", id: nextId("f"), path: e.path }] };

    case "notice":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "notice", id: nextId("n"), tone: e.level === "warn" ? "error" : "dim", text: e.message },
        ],
      };

    case "context.compacted":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("n"),
            tone: "dim",
            text: `context compacted: dropped ${e.droppedTurns} earlier messages`,
          },
        ],
      };

    case "context.usage":
      return { ...state, context: { usedTokens: e.usedTokens, budgetTokens: e.budgetTokens, percent: e.percent } };

    case "context.microcompacted":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("n"),
            tone: "dim",
            text: `context: cleared ${(e as { clearedResults: number }).clearedResults} old tool outputs`,
          },
        ],
      };

    case "provider.retry":
      // Transient status only (no transcript row): the provider is backing off
      // before retrying a 429/5xx/network blip. Cleared by the next successful
      // provider response (usage.updated) or run end.
      return {
        ...state,
        retryStatus: {
          attempt: e.attempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          reason: e.reason,
        },
      };

    case "usage.updated":
      // Cumulative cost is taken from session.completed (avoid double
      // counting); the in-turn number drives the live activity counter. A
      // successful provider response also clears any pending retry indicator.
      return {
        ...state,
        turnTokens: e.usage.promptTokens + e.usage.completionTokens,
        retryStatus: undefined,
      };

    case "session.completed":
      return {
        ...state,
        totalUsage: addUsage(state.totalUsage, e.report.usage),
        items: [...state.items, { kind: "report", id: nextId("r"), report: e.report }],
      };

    case "command.output": {
      // Live tail on the most recent running run_command row (cap ~400 chars).
      const idx = lastRunningToolIndex(state.items, "run_command");
      if (idx < 0) return state;
      const next = state.items.slice();
      const row = next[idx] as ChatItem & { kind: "tool" };
      const merged = ((row.outputTail ?? "") + e.chunk).slice(-400);
      next[idx] = { ...row, outputTail: merged };
      return { ...state, items: next };
    }

    case "session.failed": {
      const hint = e.error.hint ? `\n  → ${e.error.hint}` : "";
      // A genuine, recoverable failure (not a user cancel): tell the user the
      // exact resume command. The session id comes from the error (set by the
      // loop) or, failing that, the session id we already track.
      const resumeId = e.error.recoverable ? (e.error.sessionId ?? state.sessionId) : undefined;
      const recover = resumeId
        ? `\n  → resume with /resume ${resumeId} (your file changes and completed steps are preserved; checkpoints intact)`
        : "";
      return {
        ...state,
        retryStatus: undefined,
        items: [
          ...state.items,
          {
            kind: "notice",
            id: nextId("n"),
            tone: "error",
            text: `failed: ${e.error.code} — ${e.error.message}${hint}${recover}`,
          },
        ],
      };
    }

    default:
      return state; // command.output / step.completed: silent for now
  }
}

/**
 * Tracks background tasks from tool completions: run_command background:true
 * returns { taskId }, task_kill/task_output report { taskId, status }.
 */
function applyBgEvent(state: ChatState, toolName: string, ok: boolean, data: unknown, args: unknown): ChatState {
  if (!ok || typeof data !== "object" || data === null) return state;
  const taskId = (data as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string") return state;

  if (toolName === "run_command") {
    const command =
      typeof (args as { command?: unknown })?.command === "string"
        ? (args as { command: string }).command
        : "(unknown command)";
    if (state.bgTasks.some((t) => t.id === taskId)) return state;
    return { ...state, bgTasks: [...state.bgTasks, { id: taskId, command, status: "running" }] };
  }

  if (toolName === "task_kill") {
    return {
      ...state,
      bgTasks: state.bgTasks.map((t): BgTask => (t.id === taskId ? { ...t, status: "exited" } : t)),
    };
  }

  if (toolName === "task_output") {
    const status = (data as { status?: unknown }).status;
    if (status !== "running" && status !== "exited") return state;
    return {
      ...state,
      bgTasks: state.bgTasks.map((t): BgTask => (t.id === taskId ? { ...t, status } : t)),
    };
  }

  return state;
}

const RESULT_PREVIEW_CHARS = 1500;

/** Compact JSON preview of a tool result for verbose mode. */
function previewData(data: unknown): string {
  let text: string;
  try {
    text = typeof data === "string" ? data : (JSON.stringify(data, null, 1) ?? "");
  } catch {
    text = String(data);
  }
  return text.length > RESULT_PREVIEW_CHARS ? `${text.slice(0, RESULT_PREVIEW_CHARS)}…` : text;
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
