import {
  createDispatchManager,
  loadAgentDefinitions,
  loadPluginContributions,
  type BackgroundTasks,
  type DispatchManager,
  type PluginContributions,
  type ToolSpec,
} from "@seekforge/core";
import type { ApprovalMode, ConfirmResult, PermissionRequest, PermissionRule } from "@seekforge/shared";
import type { TuiConfig } from "../config.js";
import { expandFileRefs } from "@seekforge/shared/file-refs";
import { createTuiAgent } from "./factory.js";
import type { UsageBus } from "@seekforge/core";
import { createDiffCapture } from "../diff-capture.js";
import { createBufferedDispatch } from "../delta-buffer.js";
import type { ChatAction } from "../model.js";

export type RunSessionDeps = {
  config: TuiConfig;
  model: string;
  projectPath: string;
  mcpToolSpecs: ToolSpec[];
  pluginContributions?: PluginContributions;
  /** ask = read-only investigation; edit = normal. */
  mode: "ask" | "edit";
  /** Plan flavor: read-only run that produces an implementation plan. */
  plan: boolean;
  /** auto skips confirmations (the TUI's auto approval setting). */
  approvalMode: ApprovalMode;
  /** Shared background-task manager (tasks outlive single runs). */
  background: BackgroundTasks;
  /** Routes the ask_user tool to the TUI question overlay. */
  askUser: (q: { question: string; options: string[]; freeText?: boolean }) => Promise<string>;
  /** Pushes a reducer action (events, deltas, lifecycle) into the UI state. */
  dispatch: (action: ChatAction) => void;
  /**
   * Awaits the inline PermissionPanel's y/a/n answer. "a" returns the richer
   * { allow: true, remember: "session" } so CORE grows its session allowlist.
   */
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  /** Writes a durable ("always") approval to the user config; absent = never offered. */
  persistRule?: (rule: PermissionRule) => Promise<void> | void;
  /** Resolves the current session id for resume chaining. */
  getSessionId: () => string | undefined;
  /** Binds controls to this exact run; undefined clears them during cleanup. */
  onDispatchManager?: (manager: DispatchManager | undefined) => void;
  /** Session usage bus: tokens an MCP server spent through sampling. */
  usageBus?: UsageBus;
};

/**
 * Drives a single agent turn: assembles the agent, consumes runTask events
 * into the reducer, and routes streamed model deltas to the live assistant
 * item. Cancellation is cooperative via the AbortSignal.
 */
export async function runSession(task: string, signal: AbortSignal, deps: RunSessionDeps): Promise<void> {
  // Coalesce per-token deltas and live output into ~20fps dispatches so the
  // transcript doesn't repaint on every chunk (anti-flicker).
  const buffered = createBufferedDispatch(deps.dispatch);
  const dispatchManager = createDispatchManager();
  const pluginContributions = deps.pluginContributions ?? loadPluginContributions(deps.projectPath);

  const { agent, dispose } = createTuiAgent({
    config: deps.config,
    workspace: deps.projectPath,
    model: deps.model,
    confirm: deps.confirm,
    ...(deps.persistRule ? { persistRule: deps.persistRule } : {}),
    onModelDelta: (chunk) => buffered.dispatch({ type: "model-delta", chunk }),
    onReasoningDelta: (chunk) => buffered.dispatch({ type: "thinking-delta", chunk }),
    extractMemory: true,
    subagents: loadAgentDefinitions(deps.projectPath, pluginContributions),
    mcpToolSpecs: deps.mcpToolSpecs,
    pluginContributions,
    background: deps.background,
    askUser: deps.askUser,
    dispatchManager,
    ...(deps.usageBus ? { usageBus: deps.usageBus } : {}),
    // The status line's cost and any costBudgetUsd threshold are both 0 forever
    // on an unpriced model, and a reading of $0.0000 is indistinguishable from
    // a run that was free. Fired once per (provider, model) — the agent is
    // rebuilt every turn, and buildAgentCoreDeps owns that gate for every
    // frontend rather than each keeping its own.
    onPricingUnavailable: ({ provider, model }) => {
      deps.dispatch({
        type: "notice",
        tone: "error",
        text: `no price is known for ${model}${provider ? ` on provider "${provider}"` : ""} — cost reports 0; set modelPricing in config`,
      });
    },
  });

  // One capture per run: snapshots files around write tools to render diffs.
  const capture = createDiffCapture(deps.projectPath);
  deps.onDispatchManager?.(dispatchManager);

  try {
    for await (const event of agent.runTask({
      projectPath: deps.projectPath,
      task: expandFileRefs(task, deps.projectPath),
      mode: deps.mode,
      plan: deps.plan,
      approvalMode: deps.approvalMode,
      resumeSessionId: deps.getSessionId(),
      signal,
    })) {
      buffered.dispatch({ type: "event", event });
      const diff = capture.onEvent(event);
      if (diff) buffered.dispatch({ type: "diff", path: diff.path, lines: diff.lines });
    }
  } finally {
    buffered.flush();
    deps.onDispatchManager?.(undefined);
    dispose();
  }
}
