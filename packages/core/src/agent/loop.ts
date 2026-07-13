import {
  DEFAULT_LIMITS,
  type AgentEvent,
  type AgentLimits,
  type ChatMessage,
  type ConfirmResult,
  type FinalReport,
  type PermissionRequest,
  type PermissionRule,
  type ProviderToolCall,
  type TokenUsage,
  type ToolResult,
} from "@seekforge/shared";
import type { ChatProvider, RetryInfo } from "../provider/index.js";
import type { RuntimeClient } from "../runtime/index.js";
import {
  createBackgroundTasks,
  digestCommandOutput,
  disposeBrowser,
  commandInvokes,
  disposeLspServers,
  runShellCommand,
  TEST_COMMAND_TIMEOUT_MS,
  truncateHeadTail,
  type BackgroundTasks,
  type SandboxLevel,
  type ToolContext,
  type ToolDispatcher,
} from "../tools/index.js";
import { buildMemoryBrief, extractMemoryFromSession, recordFactUse } from "../memory/index.js";
import { buildSkillBrief, loadSkills, logSkillUsage, selectSkills } from "../skills/index.js";
import {
  AGENT_RESULT_TOOL,
  AGENT_SEND_TOOL,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DISPATCH_AGENT_TOOL,
  buildAgentResultToolDefinition,
  buildAgentSendToolDefinition,
  buildDispatchToolDefinition,
  buildSubagentPrompt,
  buildSubagentRoster,
  createDispatchManager,
  createEventQueue,
  whitelistDispatcher,
  type AgentDefinition,
  type DispatchHooks,
  type DispatchManager,
} from "../subagents/index.js";
import {
  clearOldToolResults,
  compactMessages,
  estimateMessagesTokens,
  llmCompactMessages,
  shrinkToolResultsToFit,
} from "./context.js";
import { nextFinalizeNudge, type FinalizeKind } from "./finalize.js";
import { buildRelevantFiles, buildRepoOverview, lazyFileGraph, scanRepo } from "./repo-map.js";
import type { PlanItem } from "../tools/builtins/plan.js";
import { buildHookContext, runHooks, type HookConfig, type HookOutcome } from "../hooks/index.js";
import { classifyAgentError } from "./errors.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildCommandRoster, loadUserCommands } from "./commands.js";
import { collectProjectRules } from "./rules.js";
import { appendCheckpoint, createSessionTrace, loadSessionMessages, newSessionId, readSessionMeta, writeSessionMeta } from "./trace.js";
import type { AgentCore, RunAgentTaskInput } from "./index.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Mutable handoff between a provider (built in the app factory) and a run's
 * event stream. One bus is created per factory and shared by every provider
 * it builds (main + per-model); the active run owns `emit` for its lifetime.
 * Calls outside a run (or after one ends) are no-ops.
 */
export type RetryBus = { emit?: (info: RetryInfo) => void };

/** Convenience: a fresh bus plus the onRetry callback to hand the provider. */
export function createRetryBus(): RetryBus & { onRetry: (info: RetryInfo) => void } {
  const bus: RetryBus = {};
  return Object.assign(bus, { onRetry: (info: RetryInfo) => bus.emit?.(info) });
}

const activeSessionRuns = new Set<string>();

function sessionRunKey(workspace: string, sessionId: string): string {
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    root = resolve(workspace);
  }
  return `${root}\0${sessionId}`;
}

/** True while this process is actively appending to the persisted session. */
export function isSessionRunActive(workspace: string, sessionId: string): boolean {
  return activeSessionRuns.has(sessionRunKey(workspace, sessionId));
}

/** True when any persisted session in this workspace is currently running. */
export function hasActiveSessionRuns(workspace: string): boolean {
  const prefix = `${sessionRunKey(workspace, "").slice(0, -1)}\0`;
  for (const key of activeSessionRuns) if (key.startsWith(prefix)) return true;
  return false;
}

export type AgentCoreDeps = {
  provider: ChatProvider;
  dispatcher: ToolDispatcher;
  /**
   * Asks the user for permission; must surface the raw command/path. May
   * resolve a plain boolean (allow-once / deny — the original contract) or a
   * ConfirmResult object (`{ allow, remember: "session" }`) to grow the run's
   * allow-for-session allowlist. Frontends can keep returning booleans and opt
   * into the richer form later (a follow-up — see docs).
   */
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  /**
   * Interactive question channel (TUI), backing the ask_user tool. Absent in
   * non-interactive runs; never forwarded to nested subagent runs (they must
   * not block on user input).
   */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
  limits?: Partial<AgentLimits>;
  /** Model context window in tokens. DeepSeek: 128K. */
  contextWindowTokens?: number;
  /**
   * Full-compaction strategy when still over budget after micro-compaction:
   * "llm" summarizes the dropped middle with one extra provider call and
   * falls back to the mechanical digest on any provider failure. Default
   * "mechanical" (no extra model call, fully deterministic).
   */
  compaction?: "mechanical" | "llm";
  /**
   * Optional focus steering the LLM auto-compaction summary toward what the
   * user cares about (appended to the summarization prompt as "focus
   * especially on: <focus>"). Ignored when compaction is "mechanical".
   * Frontends can surface this from a /compact <focus> directive.
   */
  compactFocus?: string;
  /** When set, model output is streamed through this callback (chatStream). */
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (DeepSeek V4 thinking mode). */
  onReasoningDelta?: (chunk: string) => void;
  /** Post-task memory extraction (one extra model call) for edit sessions. */
  extractMemory?: boolean;
  /**
   * Opt-in (default OFF): confidence threshold above which auto-extracted facts
   * are written DIRECTLY to project.md as approved (instead of queued pending).
   * Threaded into extractMemoryFromSession; unset = every fact stays pending.
   */
  memoryAutoApproveConfidence?: number;
  /** Rust execution backend; passed through to tools via ToolContext. */
  runtime?: RuntimeClient;
  /**
   * OS-level sandbox for run_command (seatbelt on darwin, bwrap on linux).
   * "off" or absent = no wrapper. Inherited by nested subagent runs.
   */
  sandbox?: SandboxLevel;
  /** Extra command prefixes the user allows to auto-run (L2). */
  commandAllowlist?: string[];
  /** Fine-grained allow/deny rules, project rules first (first match wins). */
  permissionRules?: PermissionRule[];
  /** Specialist agents dispatchable via the synthetic dispatch_agent tool. */
  subagents?: AgentDefinition[];
  /**
   * Shared background-task manager. When provided, the CALLER owns its
   * lifecycle: tasks survive across runs (a TUI/REPL session spanning many
   * turns) and are not killed when one run ends. Unset, each run gets its
   * own manager, disposed when the session ends.
   */
  background?: BackgroundTasks;
  /**
   * Builds a provider for a subagent's `model` override. Unset, or for
   * definitions without a model, dispatches use the default provider.
   */
  providerForModel?: (model: string) => ChatProvider;
  /**
   * Model used for plan runs (input.plan === true) instead of the default
   * provider's model, resolved through providerForModel. Lets /plan think on
   * deepseek-v4-pro while execution runs on flash. Ignored when
   * providerForModel is unset or input.plan is false.
   */
  planModel?: string;
  /**
   * Default-off failure escalation: after the model loops on an identical failed
   * tool call, route the rest of the run through `planModel` (needs
   * providerForModel + planModel set) — a stronger model takes over once it's
   * clearly stuck. (autoReview/planFirst levers were removed: an eval A/B showed
   * they regressed quality and cost on every edit — see CHANGELOG round 36.)
   */
  escalateOnFailure?: boolean;
  /**
   * Self-verification gate: a shell command (e.g. "pnpm test") that must pass
   * before the run finishes when it has edited files but not run it since the
   * last edit. With autoVerify (default), the LOOP runs it itself on the
   * finish turn and feeds the real result back — a passing run is accepted, a
   * failing run continues with the captured output so the agent fixes the
   * cause. With autoVerify disabled it degrades to a one-time nudge asking the
   * model to run it. Off when unset/empty.
   */
  verifyCommand?: string;
  /**
   * When a verifyCommand is set, run it automatically on the finish turn
   * instead of only nudging the model to. Default true. Set false to keep the
   * old nudge-only behavior (e.g. when the command must go through the model's
   * permission flow, or in environments where the loop should never shell out).
   */
  autoVerify?: boolean;
  /**
   * Self-lint gate: a shell command (e.g. "pnpm lint") that must pass before the
   * run finishes when it has edited files but not run it since the last edit.
   * Parallel to verifyCommand — with autoLint (default), the LOOP runs it itself
   * on the finish turn and feeds the real result back (a passing run is accepted,
   * a failing run continues with the captured lint output so the agent fixes it).
   * With autoLint disabled it degrades to a one-time nudge. Off when unset/empty.
   */
  lintCommand?: string;
  /**
   * When a lintCommand is set, run it automatically on the finish turn instead
   * of only nudging the model to. Default true. Set false to keep nudge-only
   * behavior (mirrors autoVerify).
   */
  autoLint?: boolean;
  /**
   * Default-off: when the agent finishes after editing files, nudge it once to
   * self-review its own diff (leftover debug code, missed cases, task coverage)
   * before the run completes. Costs one extra turn when it fires.
   */
  finalizeReview?: boolean;
  /**
   * Default-off premature-finish guard: if an edit-mode run declares done having
   * changed nothing and made almost no tool calls (a bail-out without really
   * investigating), nudge it once to actually work the task. Fires only on clear
   * non-work, so it does not add a turn to legitimate quick finishes.
   */
  guardNoProgress?: boolean;
  /**
   * Inject the task-relevant project-memory brief into the system prompt.
   * Default true; set false to run without memory (used by the eval A/B that
   * measures whether memory actually helps — see the `no-memory` variant).
   */
  injectMemory?: boolean;
  /**
   * Inject the task-relevant file shortlist (buildRelevantFiles) into the system
   * prompt. Default true; set false to run without retrieval (used by the eval
   * A/B that measures whether retrieval actually helps — see the `no-retrieval`
   * variant).
   */
  injectRelevantFiles?: boolean;
  /**
   * Model-adaptive edit format guidance in the system prompt. Default "patch"
   * (today's behavior): guide the agent to use apply_patch search/replace edits.
   * "whole" instead guides it to prefer write_file (rewrite the whole file) —
   * for weak/local models that struggle to produce exact search/replace blocks.
   * Guidance only: apply_patch stays fully available either way.
   */
  editFormat?: "patch" | "whole";
  /**
   * User-configured shell hooks. preToolUse/postToolUse reach the dispatcher
   * via ToolContext and fire around every tool run (nested subagent runs
   * included). sessionStart/userPromptSubmit/stop/sessionEnd fire only for
   * the top-level session; userPromptSubmit can block the run, and its hook
   * stdout is appended to the task as <hook-context>. preCompact,
   * subagentStop and notification are advisory (see hooks/index.ts).
   */
  hooks?: HookConfig;
  /**
   * Retry-progress bridge. The provider is built outside the loop (in the app
   * factory), so its onRetry callback cannot reach this run's event stream
   * directly. The factory wires the provider's onRetry to `retryBus.emit` and
   * passes the SAME bus here; the loop installs `emit` for the duration of the
   * run, turning each retry into a `provider.retry` event, and clears it after.
   * Unset = retry progress is not surfaced (the provider still retries).
   */
  retryBus?: RetryBus;
  /** Internal: nesting depth. Depth > 0 never advertises dispatch_agent. */
  _depth?: number;
  /** Internal: dispatch-manager override (test seam). */
  _dispatchManager?: DispatchManager;
};

const OUTPUT_RESERVE_TOKENS = 8192;

/**
 * Turn counts (remaining) at which the loop nudges the model to wrap up.
 * Injected as TRANSIENT user messages: they go to the provider but are NOT
 * written to messages.jsonl, because the stored session must keep exactly
 * one user message per run — truncateSessionAtUserTurn, checkpoint `turn`
 * tagging, and the TUI backtrack targets all count user messages and assume
 * that invariant (see apps/tui/src/backtrack.ts). A resumed session simply
 * replays without the nudge, which is correct: it gets a fresh turn budget.
 */
const WRAPUP_THRESHOLDS = [3, 1] as const;

function buildWrapupNudge(turnsLeft: number): string {
  return (
    `[harness] Turn budget nearly exhausted (${turnsLeft} ${turnsLeft === 1 ? "turn" : "turns"} left). ` +
    "Stop exploring; finish the most important remaining edit and produce the final report now. " +
    "If work remains, list it under ## Notes as next steps."
  );
}

/** Turns to wait before another reflection nudge can fire (avoid nagging). */
const REFLECTION_COOLDOWN_TURNS = 3;

function buildReflectionNudge(): string {
  return (
    "[harness] You just repeated a tool call that already failed earlier with the same arguments — " +
    "you are looping. Stop guessing: re-read the relevant code/output to understand WHY it fails, " +
    "then take a different approach. Do not issue that identical call again."
  );
}

/** Recursively sorts object keys so equal args produce an equal signature. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Order-independent canonical form of a tool call's arguments JSON. */
function canonicalArgs(argumentsJson: string | undefined): string {
  if (!argumentsJson) return "";
  try {
    return JSON.stringify(sortKeys(JSON.parse(argumentsJson)));
  } catch {
    return argumentsJson;
  }
}

/**
 * Max command.output events forwarded per tool call. A chatty command keeps
 * running and its full (truncated) output still lands in the tool result;
 * only the LIVE event stream is capped (excess chunks dropped silently) so
 * one noisy server cannot flood the transcript.
 */
const MAX_STREAMED_CHUNKS_PER_CALL = 200;

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function toolResultForModel(result: ToolResult, maxChars: number): string {
  const payload = result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result.error };
  let text = JSON.stringify(payload);
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…[truncated]`;
  }
  return text;
}

/** Appends a user-supplied system-prompt suffix (CLI --append-system-prompt). */
function appendUserPrompt(base: string, append?: string): string {
  return append && append.trim() ? `${base}\n\n${append.trim()}` : base;
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const windowTokens = deps.contextWindowTokens ?? 131_072;
  // Floor at 1 so a pathologically small contextWindowTokens (where the output
  // reserve exceeds the whole budget) can't yield a zero/negative budget that
  // makes the over-budget comparison meaningless; the shrink-to-fit last resort
  // then still runs against a positive target. (Kept below any realistic budget
  // so it never affects a normally-configured window.)
  const budgetTokens = Math.max(1, Math.floor(windowTokens * limits.contextBudgetRatio) - OUTPUT_RESERVE_TOKENS);
  const depth = deps._depth ?? 0;
  // dispatch_agent is only advertised at depth 0 — dispatched runs never recurse.
  const roster: AgentDefinition[] = depth === 0 ? (deps.subagents ?? []) : [];

  return {
    async *runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent> {
      const resuming = input.resumeSessionId !== undefined;
      const sessionId = input.resumeSessionId ?? newSessionId();
      const activeRunKey = sessionRunKey(input.projectPath, sessionId);
      if (activeSessionRuns.has(activeRunKey)) {
        throw new AgentLimitError("session_busy", `session ${sessionId} is already running`);
      }
      activeSessionRuns.add(activeRunKey);
      try {
      const trace = createSessionTrace(input.projectPath, sessionId);
      const emit = (e: AgentEvent): AgentEvent => {
        trace.event(e);
        return e;
      };

      // Surface a hook's JSON `systemMessage` to the user as a notice — for
      // non-blocking outcomes (a blocking hook's systemMessage is the block
      // reason instead). Used at the loop-level hook stages below.
      function* surfaceHookNotices(outcomes: HookOutcome[]): Generator<AgentEvent> {
        for (const o of outcomes) {
          if (o.ok && o.systemMessage) yield emit({ type: "notice", level: "info", message: o.systemMessage });
        }
      }

      // Plan-model routing: a plan run thinks on deps.planModel (e.g. /plan
      // on v4-pro) while regular runs keep the default provider. Run-local —
      // resuming the session in execute mode goes back to deps.provider.
      // `let` so escalateOnFailure can swap in the stronger planModel provider
      // mid-run once the model is clearly stuck (see the turn loop below).
      let provider =
        input.plan === true && deps.planModel !== undefined
          ? (deps.providerForModel?.(deps.planModel) ?? deps.provider)
          : deps.provider;

      // Task-relevant memory brief. Gated by deps.injectMemory (default on; the
      // eval's `no-memory` variant flips it off to measure memory's value), and
      // records fact usage when a brief is actually injected (P2 lifecycle).
      // Resume is a replay: it still builds + injects the brief, but does NOT
      // bump fact usage (recordFactUse writes fact-meta.json uses/lastUsedAt) —
      // otherwise resuming would double-count usage and make resume non-idempotent.
      const memoryFor = (taskText: string): string | undefined => {
        if (deps.injectMemory === false) return undefined;
        const brief = buildMemoryBrief(input.projectPath, taskText);
        if (brief && !resuming) recordFactUse(input.projectPath, brief);
        return brief;
      };

      // Long-horizon persistence: restore a plan published in an earlier run so
      // the task's checklist survives across resume (re-injected into the system
      // prompt below, and carried through this run's meta writes).
      const priorMeta = resuming ? readSessionMeta(input.projectPath, sessionId) : undefined;
      const priorPlan = priorMeta?.plan;
      const priorUsage = priorMeta?.usage ?? ZERO_USAGE;
      // Latest plan (seeded from a resumed session); declared out here so the
      // catch's failed-meta write can preserve it too. Updated on update_plan.
      let lastPlanItems: PlanItem[] | undefined = priorPlan;
      // One tree scan shared by both prompt-injection builders below — avoids
      // walking the repo twice on every top-level run. undefined off the top
      // level (these hints are top-level only).
      const repoScan = depth === 0 ? scanRepo(input.projectPath) : undefined;
      // …and ONE dependency graph shared the same way: each builder used to
      // rebuild it internally (readFileSync + outline + identifier counts over
      // up to 600 files — twice per run, i.e. twice per TUI/REPL turn). Lazy
      // (a memoized thunk) so the builders' cheap early-outs (small repo,
      // generic task) still skip the build entirely, exactly as before.
      const repoGraph = repoScan ? lazyFileGraph(input.projectPath, repoScan) : undefined;
      // #1: a compact structural overview injected into the system prompt for
      // LARGE repos (top-level runs only), so the agent orients without grep-
      // crawling. undefined for small repos / non-local trees.
      const repoOverview = repoScan
        ? buildRepoOverview(input.projectPath, undefined, repoScan, repoGraph)
        : undefined;
      // Task-relevant file shortlist (transparent retrieval): ranks files by
      // lexical match to THIS task, so the agent starts at the likely sites
      // instead of grep-crawling. Top-level runs only; undefined for small
      // trees / generic tasks / no clear match (see buildRelevantFiles).
      const relevantFiles =
        repoScan && deps.injectRelevantFiles !== false
          ? buildRelevantFiles(input.projectPath, input.task, undefined, repoScan, repoGraph)
          : undefined;

      const startedAt = new Date().toISOString();
      const meta = {
        id: sessionId,
        task: input.task,
        mode: input.mode,
        createdAt: priorMeta?.createdAt ?? startedAt,
        ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      };
      writeSessionMeta(input.projectPath, {
        ...meta,
        status: "running",
        updatedAt: startedAt,
        ...(priorPlan ? { plan: priorPlan } : {}),
        ...(priorMeta?.usage ? { usage: priorMeta.usage } : {}),
      });
      yield emit({ type: "session.created", sessionId });

      // sessionStart/userPromptSubmit fire once for the TOP-LEVEL run only
      // (like sessionEnd); nested subagent runs (depth > 0) skip them. They
      // fire BEFORE the task message is built so that userPromptSubmit hook
      // stdout (exit 0) can be appended to the task as <hook-context> — the
      // conversation AND the trace record the augmented task. A failing hook
      // still blocks, but only inside the try below so the normal failure
      // path (session.failed, meta, sessionEnd hooks) applies.
      let task = input.task;
      let promptBlocked: HookOutcome | undefined;
      if (depth === 0) {
        const startOutcomes = await runHooks("sessionStart", deps.hooks?.sessionStart, {
          sessionId,
          workspace: input.projectPath,
          task: input.task,
          mode: input.mode,
          resuming,
        });
        yield* surfaceHookNotices(startOutcomes);
        const promptOutcomes = await runHooks("userPromptSubmit", deps.hooks?.userPromptSubmit, {
          sessionId,
          workspace: input.projectPath,
          task: input.task,
        });
        promptBlocked = promptOutcomes.find((o) => !o.ok);
        if (!promptBlocked) {
          task = input.task + buildHookContext(promptOutcomes);
          yield* surfaceHookNotices(promptOutcomes);
        }
      }

      // This run's 0-based user-turn index: how many role:"user" messages the
      // conversation holds BEFORE this run appends its task. 0 for a fresh
      // session; on resume, the count over the replayed history. Aligns with
      // truncateSessionAtUserTurn / rewindSessionToTurn indexing.
      let runTurnIndex = 0;
      let messages: ChatMessage[];
      if (resuming) {
        messages = loadSessionMessages(input.projectPath, sessionId);
        runTurnIndex = messages.filter((m) => m.role === "user").length;
        // Rebuild the system prompt for the resumed run: the mode may have
        // changed (plan -> execute) and memory approved since the original
        // run should apply. Costs one prefix-cache miss; correctness first.
        if (messages[0]?.role === "system") {
          messages[0] = {
            role: "system",
            content:
              input.systemPromptOverride ??
              appendUserPrompt(
                buildSystemPrompt({
                  workspace: input.projectPath,
                  mode: input.mode,
                  plan: input.plan,
                  projectRules: collectProjectRules(input.projectPath, undefined, input.task),
                  memoryBrief: memoryFor(input.task),
                  subagentRoster: roster.length > 0 ? buildSubagentRoster(roster) : undefined,
                  commandRoster:
                    depth === 0 ? buildCommandRoster(loadUserCommands(input.projectPath)) || undefined : undefined,
                  ...(priorPlan ? { planItems: priorPlan } : {}),
                  ...(repoOverview ? { repoOverview } : {}),
                  ...(relevantFiles ? { relevantFiles } : {}),
                  ...(deps.editFormat ? { editFormat: deps.editFormat } : {}),
                }),
                input.appendSystemPrompt,
              ),
          };
        }
        const continuation: ChatMessage = { role: "user", content: task };
        messages.push(continuation);
        trace.message(continuation);
      } else if (input.systemPromptOverride !== undefined) {
        // Internal: dispatched subagent runs replace the regular system
        // prompt (and skip skill selection — the definition is the procedure).
        messages = [
          { role: "system", content: input.systemPromptOverride },
          { role: "user", content: task },
        ];
        for (const m of messages) trace.message(m);
      } else {
        const memoryBrief = memoryFor(input.task);
        // Skills are task-execution procedures (e.g. test-failure-fix); they have
        // no place in read-only Q&A, where they're just noise. Plan runs still get
        // them (a plan benefits from the procedure).
        const skillSelections =
          input.mode === "ask" && !input.plan
            ? []
            : selectSkills(input.task, loadSkills(input.projectPath), {
                workspace: input.projectPath,
              });
        if (skillSelections.length > 0) {
          logSkillUsage(input.projectPath, sessionId, skillSelections);
          yield emit({
            type: "step.started",
            title: `skills: ${skillSelections.map((s) => s.skill.id).join(", ")}`,
          });
        }
        const systemPrompt = appendUserPrompt(
          buildSystemPrompt({
            workspace: input.projectPath,
            mode: input.mode,
            plan: input.plan,
            projectRules: collectProjectRules(input.projectPath, undefined, input.task),
            memoryBrief,
            skillBrief: buildSkillBrief(skillSelections),
            subagentRoster: roster.length > 0 ? buildSubagentRoster(roster) : undefined,
            commandRoster:
              depth === 0 ? buildCommandRoster(loadUserCommands(input.projectPath)) || undefined : undefined,
            ...(repoOverview ? { repoOverview } : {}),
            ...(relevantFiles ? { relevantFiles } : {}),
            ...(deps.editFormat ? { editFormat: deps.editFormat } : {}),
          }),
          input.appendSystemPrompt,
        );
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: task },
        ];
        for (const m of messages) trace.message(m);
      }

      const throwIfCancelled = () => {
        if (input.signal?.aborted) {
          throw new AgentLimitError("cancelled", "cancelled by user");
        }
      };

      // notification hooks fire just before the user is interrupted (a
      // permission prompt or an ask_user question), so external notifiers
      // (sound, desktop alert) can ping. Advisory; never affects the answer.
      const confirmWithNotify = async (req: PermissionRequest): Promise<ConfirmResult> => {
        await runHooks("notification", deps.hooks?.notification, {
          sessionId,
          workspace: input.projectPath,
          kind: "permission",
          detail: req,
        });
        return deps.confirm(req);
      };
      // Boolean view of confirmWithNotify for the dispatch flow, which only
      // needs allow/deny (allow-for-session has no meaning for a one-off
      // agent dispatch). Normalizes the boolean | { allow } contract.
      const confirmAllowed = async (req: PermissionRequest): Promise<boolean> => {
        const answer = await confirmWithNotify(req);
        return typeof answer === "boolean" ? answer : answer.allow;
      };
      const askUser = deps.askUser;
      const askUserWithNotify =
        askUser === undefined
          ? undefined
          : async (q: { question: string; options: string[] }): Promise<string> => {
              await runHooks("notification", deps.hooks?.notification, {
                sessionId,
                workspace: input.projectPath,
                kind: "question",
                detail: q,
              });
              return askUser(q);
            };

      // First-write-per-RUN checkpointing: each run snapshots a file's
      // pre-content the first time IT writes the file, tagged with this run's
      // user-turn index. rewindSession keeps using the oldest entry per path;
      // rewindSessionToTurn picks the earliest entry with turn >= N.
      const checkpointed = new Set<string>();
      // Run-scoped allow-for-session allowlist: one array shared by every tool
      // call this run makes, grown in place by enforcePermission when the user
      // answers "yes, don't ask again". Not persisted — it dies with the run.
      const sessionAllowlist: string[] = [];
      const ctx: ToolContext = {
        sessionId,
        workspace: input.projectPath,
        policy: {
          approvalMode: input.approvalMode,
          mode: input.mode,
          commandAllowlist: deps.commandAllowlist ?? [],
          sessionAllowlist,
          ...(deps.permissionRules ? { rules: deps.permissionRules } : {}),
        },
        confirm: confirmWithNotify,
        log: (entry) => trace.toolCall(entry),
        runtime: deps.runtime,
        hooks: deps.hooks,
        sandbox: deps.sandbox,
        background: deps.background ?? createBackgroundTasks(),
        checkpoint: (path, before) => {
          if (checkpointed.has(path)) return;
          checkpointed.add(path);
          appendCheckpoint(input.projectPath, sessionId, {
            ts: new Date().toISOString(),
            path,
            before,
            turn: runTurnIndex,
          });
        },
        // Only the top-level run may block on the user; nested subagent runs
        // never get the channel (see executeNestedRun).
        ...(depth === 0 && askUserWithNotify ? { askUser: askUserWithNotify } : {}),
      };

      const toolDefs =
        roster.length > 0
          ? [
              ...deps.dispatcher.list(),
              buildDispatchToolDefinition(roster),
              buildAgentResultToolDefinition(),
              buildAgentSendToolDefinition(),
            ]
          : deps.dispatcher.list();
      let usage = ZERO_USAGE;
      let sessionEndStatus: "completed" | "failed" | "cancelled" | undefined;
      let toolCallCount = 0;
      const changedFiles = new Set<string>();
      const commandsRun: string[] = [];
      let finalContent: string | undefined;

      // Bridges events from concurrent/background dispatches into this single
      // generator: producers push (traced immediately), the loop drains.
      const queue = createEventQueue<AgentEvent>();
      const pushEvent = (ev: AgentEvent): void => queue.push(emit(ev));

      // Drain queued events (live command output, nested-dispatch completions)
      // WHILE awaiting `outcome`, yielding each into this generator's stream,
      // then return the settled value. Shared by the tool-call and the finalize-
      // reviewer paths so both interleave events identically (the final drain
      // runs before the value is returned, so queued output precedes the result).
      async function* drainUntil<T>(outcome: Promise<T>): AsyncGenerator<AgentEvent, T> {
        for (;;) {
          const next = await Promise.race([outcome.then((v) => ({ v })), queue.wait().then(() => undefined)]);
          for (const ev of queue.drainNow()) yield ev;
          if (next !== undefined) {
            // Drain once more: events pushed onto the queue while the yields
            // above were suspended would otherwise surface only after the
            // returned value (e.g. final command output after tool.completed).
            for (const ev of queue.drainNow()) yield ev;
            return next.v;
          }
        }
      }

      // Surface provider retries as provider.retry events for the duration of
      // this run. The provider (built in the app factory) calls retryBus.emit;
      // we route it onto this run's queue, and clear the hook in finally so a
      // retry from a later run never leaks into a stale queue.
      if (deps.retryBus) {
        deps.retryBus.emit = (info: RetryInfo) =>
          pushEvent({
            type: "provider.retry",
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            delayMs: info.delayMs,
            reason: info.reason,
          });
      }
      const dispatchManager: DispatchManager | undefined =
        roster.length > 0 ? (deps._dispatchManager ?? createDispatchManager()) : undefined;

      /**
       * Runs a subagent as a nested agent core (depth+1, no further
       * dispatch), forwards nested tool activity as step.started events
       * through the event queue, merges its usage/changes into the parent,
       * and resolves with the subagent's report as the tool result.
       * `signal` is the dispatch's own (manager-chained) abort signal: on
       * abort the nested run is abandoned immediately, even when it is
       * stuck inside a provider call.
       */
      async function executeNestedRun(
        def: AgentDefinition,
        task: string,
        signal: AbortSignal,
        hooks: DispatchHooks,
        resumeSessionId?: string,
      ): Promise<ToolResult> {
        const nested = createAgentCore({
          ...deps,
          provider:
            def.model !== undefined && deps.providerForModel ? deps.providerForModel(def.model) : deps.provider,
          subagents: undefined,
          _depth: depth + 1,
          _dispatchManager: undefined,
          dispatcher: def.tools ? whitelistDispatcher(deps.dispatcher, def.tools) : deps.dispatcher,
          onModelDelta: undefined,
          extractMemory: false,
          askUser: undefined, // subagents must not block on user input
          limits: { ...deps.limits, maxAgentTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS },
        });

        let subSessionId: string | undefined;
        let nestedUsage: TokenUsage | undefined;
        let report: FinalReport | undefined;
        let failure: { code: string; message: string } | undefined;

        const events = nested
          .runTask({
            projectPath: input.projectPath,
            task,
            mode: def.mode,
            approvalMode: input.approvalMode,
            signal,
            systemPromptOverride: buildSubagentPrompt(def, input.projectPath),
            parentAgentId: def.id,
            ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
          })
          [Symbol.asyncIterator]();

        const ABORTED = Symbol("dispatch-aborted");
        let onAbort!: () => void;
        const abortPromise = new Promise<typeof ABORTED>((resolve) => {
          onAbort = () => resolve(ABORTED);
        });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });

        try {
          for (;;) {
            const step = await Promise.race([events.next(), abortPromise]);
            if (step === ABORTED) {
              // Abandon the nested run; it received the same signal, so its
              // own cooperative cancellation will stop it where possible.
              const ret = events.return?.();
              if (ret) void ret.then(undefined, () => {});
              return { ok: false, error: { code: "subagent_failed", message: "dispatch aborted" } };
            }
            if (step.done) break;
            const ev = step.value;
            switch (ev.type) {
              case "session.created":
                subSessionId = ev.sessionId;
                hooks.onSubSession(ev.sessionId);
                break;
              case "tool.started":
                // Cheap visibility into the nested run without new event types.
                hooks.onStep(ev.toolName);
                pushEvent({ type: "step.started", title: `[${def.id}] ${ev.toolName}` });
                break;
              case "file.changed":
                changedFiles.add(ev.path);
                pushEvent({ type: "file.changed", path: ev.path });
                break;
              case "usage.updated":
                nestedUsage = ev.usage; // cumulative within the nested run
                break;
              case "session.completed":
                report = ev.report;
                break;
              case "session.failed":
                failure = ev.error;
                break;
              default:
                break;
            }
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
        }

        // The nested session has its own trace (separate sessionId); record
        // the parent linkage by logging the dispatch itself.
        ctx.log?.({ tool: DISPATCH_AGENT_TOOL, agentId: def.id, task, subSessionId });

        // subagentStop: a dispatched run finished (sessionId = the parent's).
        await runHooks("subagentStop", deps.hooks?.subagentStop, {
          sessionId,
          workspace: input.projectPath,
          agentId: def.id,
          ok: failure === undefined && report !== undefined,
        });

        if (nestedUsage) {
          usage = addUsage(usage, nestedUsage);
          pushEvent({ type: "usage.updated", usage });
        }

        if (failure || !report) {
          return {
            ok: false,
            error: {
              code: "subagent_failed",
              message: failure?.message ?? "subagent run produced no final report",
            },
          };
        }
        commandsRun.push(...report.commandsRun);
        return {
          ok: true,
          data: {
            agentId: def.id,
            report: report.summary,
            changedFiles: report.changedFiles,
            commandsRun: report.commandsRun,
          },
        };
      }

      /**
       * Handles a dispatch_agent tool call. Foreground dispatches resolve
       * with the subagent's report (and are recorded in the manager so
       * agent_send can continue them later); background dispatches return
       * the dispatch id immediately while the run continues under the
       * manager (poll with agent_result).
       */
      async function runDispatch(rawArgs: unknown): Promise<ToolResult> {
        const a = rawArgs as { agentId?: unknown; task?: unknown; background?: unknown };
        const agentId = typeof a?.agentId === "string" ? a.agentId : "";
        const task = typeof a?.task === "string" ? a.task.trim() : "";
        const def = roster.find((d) => d.id === agentId);
        if (!def) {
          return {
            ok: false,
            error: { code: "unknown_agent", message: `unknown agent "${agentId || "(missing agentId)"}"` },
          };
        }
        if (!task) {
          return {
            ok: false,
            error: { code: "invalid_arguments", message: "dispatch_agent requires a non-empty task string" },
          };
        }

        // A read-only parent run (ask / plan mode) must not gain write access
        // by delegating to an edit-mode agent — that would bypass the read-only
        // guarantee. Refuse the dispatch (the agent could still run read-only,
        // but we don't silently downgrade it; the model should pick an ask agent).
        if (input.mode === "ask" && def.mode === "edit") {
          return {
            ok: false,
            error: {
              code: "forbidden_in_ask_mode",
              message: `cannot dispatch edit-mode agent "${def.id}" from a read-only (ask/plan) session`,
            },
          };
        }

        // ask-mode agents are read-only and auto-allowed; edit-mode agents
        // go through the normal approval flow (unless approvalMode is auto).
        if (def.mode === "edit" && input.approvalMode !== "auto") {
          const approved = await confirmAllowed({
            toolName: DISPATCH_AGENT_TOOL,
            permission: "write",
            description: `Dispatch agent ${def.id}: ${task.slice(0, 100)}`,
          });
          if (!approved) {
            return {
              ok: false,
              error: { code: "denied_by_user", message: `dispatch of agent "${def.id}" denied by user` },
            };
          }
        }

        const { id: dispatchId, promise } = dispatchManager!.start({
          agentId: def.id,
          task,
          signal: input.signal,
          run: (signal, hooks) => executeNestedRun(def, task, signal, hooks),
        });
        if (a?.background === true) {
          return { ok: true, data: { dispatchId, agentId: def.id, status: "running" } };
        }
        return promise;
      }

      /** Handles an agent_result tool call (synchronous status poll). */
      function handleAgentResult(rawArgs: unknown): ToolResult {
        const a = rawArgs as { dispatchId?: unknown };
        const dispatchId = typeof a?.dispatchId === "string" ? a.dispatchId : "";
        const rec = dispatchId ? dispatchManager!.get(dispatchId) : undefined;
        if (!rec) {
          return {
            ok: false,
            error: {
              code: "unknown_dispatch",
              message: `unknown dispatch "${dispatchId || "(missing dispatchId)"}"`,
            },
          };
        }
        if (rec.status === "running") {
          return { ok: true, data: { status: "running", agentId: rec.agentId, steps: rec.steps.slice(-10) } };
        }
        if (rec.status === "failed") {
          return {
            ok: false,
            error: { code: "subagent_failed", message: rec.result?.error?.message ?? "subagent run failed" },
          };
        }
        const data = rec.result?.data as
          | { report?: string; changedFiles?: string[]; commandsRun?: string[] }
          | undefined;
        return {
          ok: true,
          data: {
            status: "done",
            report: data?.report ?? "",
            changedFiles: data?.changedFiles ?? [],
            commandsRun: data?.commandsRun ?? [],
          },
        };
      }

      /**
       * Handles an agent_send tool call: continues a COMPLETED dispatch's
       * subagent with its prior context (nested resume of its session).
       * The permission flow is identical to a fresh dispatch of that
       * definition, including the read-only-parent guard.
       */
      async function runAgentSend(rawArgs: unknown): Promise<ToolResult> {
        const a = rawArgs as { dispatchId?: unknown; task?: unknown };
        const dispatchId = typeof a?.dispatchId === "string" ? a.dispatchId : "";
        const task = typeof a?.task === "string" ? a.task.trim() : "";
        if (!dispatchId || !task) {
          return {
            ok: false,
            error: { code: "invalid_arguments", message: "agent_send requires dispatchId and a non-empty task" },
          };
        }
        const rec = dispatchManager!.get(dispatchId);
        if (!rec) {
          return { ok: false, error: { code: "unknown_dispatch", message: `unknown dispatch "${dispatchId}"` } };
        }
        if (rec.status === "running") {
          return {
            ok: false,
            error: { code: "dispatch_busy", message: `dispatch ${dispatchId} is still running; poll it with agent_result` },
          };
        }
        const def = roster.find((d) => d.id === rec.agentId);
        if (!def) {
          return {
            ok: false,
            error: { code: "unknown_agent", message: `agent "${rec.agentId}" is no longer available` },
          };
        }
        if (input.mode === "ask" && def.mode === "edit") {
          return {
            ok: false,
            error: {
              code: "forbidden_in_ask_mode",
              message: `cannot dispatch edit-mode agent "${def.id}" from a read-only (ask/plan) session`,
            },
          };
        }
        if (rec.status === "failed" || rec.subSessionId === undefined) {
          return {
            ok: false,
            error: {
              code: "subagent_failed",
              message: `dispatch ${dispatchId} failed; start a fresh dispatch_agent instead`,
            },
          };
        }
        if (def.mode === "edit" && input.approvalMode !== "auto") {
          const approved = await confirmAllowed({
            toolName: AGENT_SEND_TOOL,
            permission: "write",
            description: `Dispatch agent ${def.id}: ${task.slice(0, 100)}`,
          });
          if (!approved) {
            return {
              ok: false,
              error: { code: "denied_by_user", message: `dispatch of agent "${def.id}" denied by user` },
            };
          }
        }
        const resumeSessionId = rec.subSessionId;
        return dispatchManager!.resume({
          id: dispatchId,
          task,
          signal: input.signal,
          run: (signal, hooks) => executeNestedRun(def, task, signal, hooks, resumeSessionId),
        });
      }

      try {
        // Blocking, mirroring preToolUse: a failing userPromptSubmit hook
        // (run above, before the task message was built) fails the run.
        if (promptBlocked) {
          throw new AgentLimitError(
            "blocked_by_hook",
            promptBlocked.outputTail || `blocked by userPromptSubmit hook (${promptBlocked.command})`,
          );
        }

        const wrapupInjected = new Set<number>();
        // Stuck detection: signatures (name+args) of tool calls that have
        // FAILED, so an identical re-failure can be caught as a loop.
        const seenFailedSigs = new Set<string>();
        let reflectionCooldown = 0;
        // Default-off failure escalation (see AgentCoreDeps): one-shot.
        let escalated = false;
        // Finalize gate (see finalize.ts): plan/verify/lint/review checks run
        // when the model declares it is done. Each kind fires at most once per run.
        const finalizeFired = new Set<FinalizeKind>();
        // Whether deps.verifyCommand has run since the most recent edit: an edit
        // resets it, running the command sets it, so the verify nudge fires only
        // for changes that have not been checked.
        let verifyRanSinceEdit = false;
        // Same gating for the parallel lint gate (deps.lintCommand): an edit
        // resets it, running the lint command sets it, so the lint nudge fires
        // only for changes that have not been linted.
        let lintRanSinceEdit = false;

        for (let turn = 0; turn < limits.maxAgentTurns; turn++) {
          throwIfCancelled();
          // Surface events from background dispatches between turns.
          for (const ev of queue.drainNow()) yield ev;

          // Turn-budget wrap-up nudge: once per threshold, transient (not
          // traced — see WRAPUP_THRESHOLDS for why), before the provider
          // call so this turn's request already carries it.
          const turnsLeft = limits.maxAgentTurns - turn;
          if (
            (WRAPUP_THRESHOLDS as readonly number[]).includes(turnsLeft) &&
            !wrapupInjected.has(turnsLeft)
          ) {
            wrapupInjected.add(turnsLeft);
            messages.push({ role: "user", content: buildWrapupNudge(turnsLeft) });
          }
          if (estimateMessagesTokens(messages) > budgetTokens) {
            // Micro-compaction first: blank stale tool outputs (cheap, keeps
            // structure). Full compaction only when that is not enough.
            const micro = clearOldToolResults(messages);
            if (micro.cleared > 0) {
              messages = micro.messages;
              yield emit({ type: "context.microcompacted", clearedResults: micro.cleared });
            }
            // LLM compaction when configured; null (under budget OR provider
            // failure) falls back to the mechanical digest.
            let compacted =
              (deps.compaction === "llm"
                ? await llmCompactMessages(
                    provider,
                    messages,
                    budgetTokens,
                    {
                      ...(deps.compactFocus !== undefined ? { focus: deps.compactFocus } : {}),
                      signal: input.signal,
                    },
                  )
                : null) ?? compactMessages(messages, budgetTokens);
            // Last resort: when the whole history is one assistant turn plus its
            // tool results, nothing can be dropped without orphaning a tool call
            // (compactMessages returns null) — shrink the oversized tool payloads
            // in place so the provider isn't handed an over-budget request.
            if (!compacted && estimateMessagesTokens(messages) > budgetTokens) {
              compacted = shrinkToolResultsToFit(messages, budgetTokens);
            }
            if (compacted) {
              // Advisory heads-up before compaction mutates the conversation.
              yield* surfaceHookNotices(
                await runHooks("preCompact", deps.hooks?.preCompact, {
                  sessionId,
                  workspace: input.projectPath,
                  reason: "auto",
                }),
              );
              messages = compacted.messages;
              yield emit({
                type: "context.compacted",
                droppedTurns: compacted.droppedTurns,
                summaryTokens: compacted.summaryTokens,
              });
              // #2+: a plan published earlier may have been in the dropped
              // middle. Re-inject the current plan (transient, like the other
              // nudges) so a long-horizon task keeps its checklist across
              // compaction. Self-healing — re-added after every compaction.
              if (lastPlanItems && lastPlanItems.length > 0) {
                const mark = { done: "x", in_progress: "~", pending: " " } as const;
                const lines = lastPlanItems.map((i) => `- [${mark[i.status]}] ${i.step}`).join("\n");
                messages.push({
                  role: "user",
                  content: `[harness] Current plan (kept across a context compaction — keep working it):\n${lines}`,
                });
              }
            }
          }

          const res = deps.onModelDelta
            ? await provider.chatStream(
                { messages, tools: toolDefs, signal: input.signal },
                deps.onModelDelta,
                deps.onReasoningDelta,
              )
            : await provider.chat({ messages, tools: toolDefs, signal: input.signal });
          usage = addUsage(usage, res.usage);
          yield emit({ type: "usage.updated", usage });

          // Window occupancy after each provider response (cheap estimate).
          // Distinct from usage.updated, which tracks cumulative token cost.
          const usedTokens = estimateMessagesTokens(messages);
          yield emit({
            type: "context.usage",
            usedTokens,
            budgetTokens,
            percent: Math.round((usedTokens / Math.max(budgetTokens, 1)) * 100),
          });

          if (res.content) yield emit({ type: "model.message", content: res.content });

          if (res.toolCalls.length === 0) {
            // Finalize gate (finalize.ts): before accepting "done", surface the
            // highest-priority unmet check (finish plan → verify → self-review)
            // as a one-time transient nudge and let the model continue. Each
            // kind fires once, so this adds at most a few turns and always
            // terminates.
            const nudge = nextFinalizeNudge({
              mode: input.mode,
              toolCalls: toolCallCount,
              planItems: lastPlanItems,
              changedFiles: changedFiles.size,
              verifyCommand: deps.verifyCommand,
              verifyRanSinceEdit,
              lintCommand: deps.lintCommand,
              lintRanSinceEdit,
              reviewEnabled: deps.finalizeReview === true,
              // Not on resumed runs: prior-run edits don't count toward this
              // run's changedFiles/toolCalls, so a legitimate "already done"
              // resume must not be flagged as a no-work bail-out.
              guardNoProgress: deps.guardNoProgress === true && !resuming,
              fired: finalizeFired,
            });
            // Only nudge when at least one more turn remains for the model to
            // act on it. On the final turn, accept the completion as-is —
            // otherwise the nudge would consume the model's last answer and the
            // run would end with finalContent undefined (a spurious
            // max_turns_exceeded failure instead of the work it just finished).
            if (nudge && turnsLeft > 1) {
              finalizeFired.add(nudge.kind);
              // The model's "done" turn joins the in-context history so the
              // follow-up reads coherently, then the nudge/result. Both
              // TRANSIENT (not traced), like the wrap-up/reflection/escalation
              // nudges — the stored session keeps one user message per run.
              if (res.content) messages.push({ role: "assistant", content: res.content });

              // #2 Auto-verify: rather than only asking the model to run the
              // verify command, run it HERE and feed the real result back —
              // a pass is acknowledged, a failure continues with the captured
              // output so the model fixes the actual cause. Degrades to the
              // nudge if the command cannot be run.
              const vc = deps.verifyCommand?.trim();
              if (nudge.kind === "verify" && deps.autoVerify !== false && vc) {
                yield emit({ type: "notice", level: "info", message: `Auto-verifying changes: ${vc}` });
                let followup: string;
                try {
                  const r = await runShellCommand(vc, input.projectPath, TEST_COMMAND_TIMEOUT_MS, {
                    sandbox: deps.sandbox,
                    workspace: input.projectPath,
                    signal: input.signal,
                  });
                  const output = digestCommandOutput(`${r.stdout}${r.stderr}`, 4000);
                  if (r.exitCode === 0) {
                    verifyRanSinceEdit = true;
                    followup =
                      `[harness] Auto-verify \`${vc}\` PASSED (exit 0). If the task is fully complete, ` +
                      "finish now; otherwise keep working.";
                  } else {
                    // Verify ran (and failed) since the last edit — record that
                    // so the gate stays quiet until the model edits again, but
                    // lift the once-guard so any FIX it makes is re-verified
                    // rather than shipped unchecked. A finish with no new edit
                    // is accepted (verifyRanSinceEdit stays true → no re-fire),
                    // so this can't spin on an unfixable failure.
                    verifyRanSinceEdit = true;
                    finalizeFired.delete("verify");
                    followup =
                      `[harness] Auto-verify \`${vc}\` FAILED (exit ${r.exitCode}). Output:\n${output}\n` +
                      "Diagnose and fix the cause, then finish — do not claim success until it passes.";
                  }
                } catch (err) {
                  followup =
                    `[harness] Auto-verify \`${vc}\` could not run (${err instanceof Error ? err.message : String(err)}). ` +
                    "Run it yourself with run_command, fix any failures, then finish.";
                }
                messages.push({ role: "user", content: followup });
                continue;
              }

              // #2b Auto-lint: parallel to auto-verify. Run the lint command
              // here and feed the real result back — a pass is acknowledged, a
              // failure continues with the captured output so the model fixes
              // it. Degrades to the nudge if it cannot run.
              const lc = deps.lintCommand?.trim();
              if (nudge.kind === "lint" && deps.autoLint !== false && lc) {
                yield emit({ type: "notice", level: "info", message: `Auto-linting changes: ${lc}` });
                let followup: string;
                try {
                  const r = await runShellCommand(lc, input.projectPath, TEST_COMMAND_TIMEOUT_MS, {
                    sandbox: deps.sandbox,
                    workspace: input.projectPath,
                    signal: input.signal,
                  });
                  const output = digestCommandOutput(`${r.stdout}${r.stderr}`, 4000);
                  if (r.exitCode === 0) {
                    lintRanSinceEdit = true;
                    followup =
                      `[harness] Auto-lint \`${lc}\` PASSED (exit 0). If the task is fully complete, ` +
                      "finish now; otherwise keep working.";
                  } else {
                    // Same as verify: record it ran (stay quiet until the next
                    // edit) but lift the once-guard so a FIX is re-linted; a
                    // finish with no new edit is accepted (no re-fire), so this
                    // cannot spin on an unfixable lint failure.
                    lintRanSinceEdit = true;
                    finalizeFired.delete("lint");
                    followup =
                      `[harness] Auto-lint \`${lc}\` FAILED (exit ${r.exitCode}). Output:\n${output}\n` +
                      "Fix the reported lint issues, then finish — do not claim success until it passes.";
                  }
                } catch (err) {
                  followup =
                    `[harness] Auto-lint \`${lc}\` could not run (${err instanceof Error ? err.message : String(err)}). ` +
                    "Run it yourself with run_command, fix any failures, then finish.";
                }
                messages.push({ role: "user", content: followup });
                continue;
              }

              // #3 Reviewer subagent: when a final review is due and a reviewer
              // specialist is available, dispatch it (fresh context, read-only)
              // and feed its findings back — a real second pair of eyes instead
              // of asking the model to review itself. Degrades to the self-
              // review nudge when no reviewer is wired in.
              if (nudge.kind === "review" && dispatchManager !== undefined && roster.some((d) => d.id === "reviewer")) {
                yield emit({ type: "notice", level: "info", message: "Dispatching the reviewer for a final review." });
                let followup = nudge.message;
                try {
                  const outcome = runDispatch({
                    agentId: "reviewer",
                    task:
                      "Review the changes made in this session for correctness, safety, and quality " +
                      "defects: inspect git_diff / git_status and the surrounding code. Report findings " +
                      "as file:line with the smallest fix, ending with a ship / fix-first / needs-rework verdict.",
                  });
                  // runDispatch streams nested events onto the queue; drain
                  // while awaiting, like the regular dispatch execution path.
                  const r = yield* drainUntil(outcome);
                  const report = r.ok ? ((r.data as { report?: string } | undefined)?.report ?? "").trim() : "";
                  if (report) {
                    followup =
                      "[harness] A reviewer agent reviewed your changes:\n\n" +
                      `${truncateHeadTail(report, 4000).text}\n\n` +
                      "Address any real Bug/Risk findings (use judgement on pure style), then finish. " +
                      "If nothing needs fixing, say so briefly and finish.";
                  }
                } catch {
                  // Reviewer dispatch failed → fall back to the self-review nudge.
                }
                messages.push({ role: "user", content: followup });
                continue;
              }

              yield emit({ type: "notice", level: "info", message: nudge.notice });
              messages.push({ role: "user", content: nudge.message });
              continue;
            }
            finalContent = res.content;
            // Trace the final assistant message so session resume replays it.
            trace.message({ role: "assistant", content: res.content });
            break;
          }

          const assistantMsg: ChatMessage = {
            role: "assistant",
            content: res.content,
            toolCalls: res.toolCalls,
          };
          messages.push(assistantMsg);
          trace.message(assistantMsg);

          const turnCalls = res.toolCalls;
          const callResults: (ToolResult | undefined)[] = new Array(turnCalls.length);
          let pendingDispatches = 0;

          const beginCall = (tc: ProviderToolCall): { args: unknown; parseError?: ToolResult } => {
            toolCallCount++;
            if (toolCallCount > limits.maxToolCalls) {
              throw new AgentLimitError("max_tool_calls_exceeded", `exceeded ${limits.maxToolCalls} tool calls`);
            }
            try {
              return { args: tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {} };
            } catch {
              return {
                args: {},
                parseError: {
                  ok: false,
                  error: { code: "invalid_json", message: "tool call arguments were not valid JSON" },
                },
              };
            }
          };

          const isDispatchFamily = (name: string): boolean =>
            dispatchManager !== undefined && (name === DISPATCH_AGENT_TOOL || name === AGENT_SEND_TOOL);

          // Dispatch-family calls of this turn start first and run
          // CONCURRENTLY; their nested events flow through the queue while
          // the remaining tool calls execute sequentially below.
          for (let i = 0; i < turnCalls.length; i++) {
            const tc = turnCalls[i]!;
            if (!isDispatchFamily(tc.name)) continue;
            throwIfCancelled();
            const { args, parseError } = beginCall(tc);
            yield emit({ type: "tool.started", toolName: tc.name, args });
            if (parseError) {
              callResults[i] = parseError;
              yield emit({ type: "tool.completed", toolName: tc.name, result: parseError });
              continue;
            }
            pendingDispatches++;
            const run = tc.name === DISPATCH_AGENT_TOOL ? runDispatch(args) : runAgentSend(args);
            void run
              .then(
                (result) => result,
                (err: unknown): ToolResult => ({
                  ok: false,
                  error: { code: "subagent_failed", message: err instanceof Error ? err.message : String(err) },
                }),
              )
              .then((result) => {
                callResults[i] = result;
                pendingDispatches--;
                pushEvent({ type: "tool.completed", toolName: tc.name, result });
              });
          }

          // Non-dispatch calls still run sequentially, in their original order.
          for (let i = 0; i < turnCalls.length; i++) {
            const tc = turnCalls[i]!;
            if (isDispatchFamily(tc.name)) continue;
            throwIfCancelled();
            const { args, parseError } = beginCall(tc);
            yield emit({ type: "tool.started", toolName: tc.name, args });
            let result: ToolResult;
            if (parseError) {
              result = parseError;
            } else if (dispatchManager !== undefined && tc.name === AGENT_RESULT_TOOL) {
              result = handleAgentResult(args);
            } else {
              // Live output: this call gets its own emitOutput that feeds
              // command.output events into the run's queue (capped per call).
              let streamedChunks = 0;
              const callCtx: ToolContext = {
                ...ctx,
                signal: input.signal,
                emitOutput: (stream, chunk) => {
                  if (streamedChunks >= MAX_STREAMED_CHUNKS_PER_CALL) return;
                  streamedChunks++;
                  pushEvent({ type: "command.output", stream, chunk });
                },
              };
              // preToolUse/postToolUse hooks fire inside the dispatcher
              // (after permission enforcement, around tool.run).
              const outcome: Promise<{ ok: true; result: ToolResult } | { ok: false; err: unknown }> =
                deps.dispatcher.execute({ id: tc.id, name: tc.name, arguments: args }, callCtx).then(
                  (r) => ({ ok: true as const, result: r }),
                  (err: unknown) => ({ ok: false as const, err }),
                );
              // Yield queued events WHILE the tool runs (live command output,
              // background dispatch completions) — the same race
              // executeNestedRun uses against the queue. The final drain after
              // the tool settles runs BEFORE its tool.completed is emitted,
              // so output events always precede their call's completion.
              const settled = yield* drainUntil(outcome);
              if (!settled.ok) throw settled.err; // preserve pre-streaming rejection behavior
              result = settled.result;
            }
            yield emit({ type: "tool.completed", toolName: tc.name, result });

            if (result.ok && result.meta?.path && (tc.name === "apply_patch" || tc.name === "write_file")) {
              changedFiles.add(result.meta.path);
              yield emit({ type: "file.changed", path: result.meta.path });
              // New edits invalidate any earlier verify/lint run (finalize gate).
              verifyRanSinceEdit = false;
              lintRanSinceEdit = false;
            }
            if (tc.name === "run_command" && result.meta?.command) {
              commandsRun.push(result.meta.command);
              // A verify/lint run counts only when the command actually ran it.
              const vc = deps.verifyCommand?.trim();
              if (result.ok && vc && commandInvokes(result.meta.command, vc)) verifyRanSinceEdit = true;
              const lc = deps.lintCommand?.trim();
              if (result.ok && lc && commandInvokes(result.meta.command, lc)) lintRanSinceEdit = true;
            }
            // Track the latest published plan for the finalize completeness check
            // AND persist it to the session so it survives across resume (#2).
            if (tc.name === "update_plan" && result.ok) {
              const items = (result.data as { items?: PlanItem[] } | undefined)?.items;
              if (Array.isArray(items)) {
                lastPlanItems = items;
                writeSessionMeta(input.projectPath, {
                  ...meta,
                  status: "running",
                  updatedAt: new Date().toISOString(),
                  usage: addUsage(priorUsage, usage),
                  plan: items,
                });
              }
            }
            callResults[i] = result;
            for (const ev of queue.drainNow()) yield ev;
          }

          // Await this turn's dispatches, streaming their events as they
          // arrive (every completion pushes its tool.completed, so waiting
          // always makes progress).
          while (pendingDispatches > 0) {
            // Honor cancellation here too: without this, an abort mid-turn waits
            // for the slowest in-flight dispatch's next yield (seconds under a
            // slow provider) instead of unwinding promptly.
            throwIfCancelled();
            await queue.wait();
            for (const ev of queue.drainNow()) yield ev;
          }
          for (const ev of queue.drainNow()) yield ev;

          // Tool results are appended in the ORIGINAL call order regardless
          // of dispatch completion order (the model matches by toolCallId).
          for (let i = 0; i < turnCalls.length; i++) {
            const toolMsg: ChatMessage = {
              role: "tool",
              content: toolResultForModel(callResults[i]!, limits.toolOutputMaxChars),
              toolCallId: turnCalls[i]!.id,
            };
            messages.push(toolMsg);
            trace.message(toolMsg);
          }

          // Stuck detection: if a tool call failed with the SAME (name+args) as
          // one that already failed this run, the model is looping. The arg
          // signature is canonicalized (sorted keys) so reordered-but-equal
          // args still match. Inject a one-time reflection nudge — TRANSIENT
          // (pushed to messages so the model sees it in-context, NOT traced),
          // mirroring the wrap-up nudge. Tracing it would write an extra
          // role:"user" message and break the one-user-message-per-run invariant
          // that truncateSessionAtUserTurn, checkpoint `turn` tagging, and the
          // TUI/desktop backtrack targets all depend on (they count user
          // messages). A resumed run simply replays without it.
          if (reflectionCooldown > 0) reflectionCooldown--;
          let repeatedFailure = false;
          for (let i = 0; i < turnCalls.length; i++) {
            const r = callResults[i];
            if (!r || r.ok) continue;
            const sig = `${turnCalls[i]!.name}:${canonicalArgs(turnCalls[i]!.argumentsJson)}`;
            if (seenFailedSigs.has(sig)) repeatedFailure = true;
            seenFailedSigs.add(sig);
          }
          if (repeatedFailure && reflectionCooldown === 0) {
            reflectionCooldown = REFLECTION_COOLDOWN_TURNS;
            messages.push({ role: "user", content: buildReflectionNudge() });
          }

          // escalateOnFailure: once the model is clearly looping, hand the rest
          // of the run to the stronger planModel (one-time, needs the routing
          // deps). Pairs with the reflection nudge above.
          if (
            repeatedFailure &&
            deps.escalateOnFailure &&
            !escalated &&
            deps.planModel !== undefined &&
            deps.providerForModel !== undefined
          ) {
            const stronger = deps.providerForModel(deps.planModel);
            if (stronger !== provider) {
              provider = stronger;
              escalated = true;
              // TRANSIENT (pushed, not traced), like the reflection/wrap-up
              // nudges: the model sees it in-context this run, but tracing it
              // would add an extra role:"user" message and break the
              // one-user-message-per-run invariant that backtrack/resume rely on.
              messages.push({
                role: "user",
                content: `[harness] Escalated to ${deps.planModel} for the rest of this run.`,
              });
            }
          }
        }

        for (const ev of queue.drainNow()) yield ev;

        if (finalContent === undefined) {
          throw new AgentLimitError("max_turns_exceeded", `no final answer within ${limits.maxAgentTurns} turns`);
        }

        const report: FinalReport = {
          summary: finalContent,
          changedFiles: [...changedFiles],
          commandsRun,
          verification: commandsRun.length > 0 ? `commands run: ${commandsRun.join("; ")}` : "no commands were run",
          usage,
        };
        trace.summary(finalContent);
        writeSessionMeta(input.projectPath, {
          ...meta,
          status: "completed",
          updatedAt: new Date().toISOString(),
          usage: addUsage(priorUsage, usage),
          ...(lastPlanItems ? { plan: lastPlanItems } : {}),
        });

        if (deps.extractMemory && input.mode === "edit") {
          yield emit({ type: "step.started", title: "extracting memory" });
          try {
            await extractMemoryFromSession(deps.provider, {
              workspace: input.projectPath,
              sessionId,
              task: input.task,
              report,
              messages,
              ...(deps.memoryAutoApproveConfidence !== undefined
                ? { autoApproveConfidence: deps.memoryAutoApproveConfidence }
                : {}),
            });
            yield emit({ type: "step.completed", title: "extracting memory" });
          } catch {
            // memory extraction must never fail the session
          }
        }

        sessionEndStatus = "completed";
        yield emit({ type: "session.completed", report });
        // stop fires after a SUCCESSFUL top-level completion only (never on
        // failure/cancel — sessionEnd covers those). Advisory.
        if (depth === 0) {
          await runHooks("stop", deps.hooks?.stop, {
            sessionId,
            workspace: input.projectPath,
            summary: finalContent,
          });
        }
      } catch (err) {
        const e = err as Partial<AgentLimitError> & Error;
        const code = e.code ?? "agent_error";
        sessionEndStatus = code === "cancelled" ? "cancelled" : "failed";
        writeSessionMeta(input.projectPath, {
          ...meta,
          status: code === "cancelled" ? "cancelled" : "failed",
          updatedAt: new Date().toISOString(),
          usage: addUsage(priorUsage, usage),
          ...(lastPlanItems ? { plan: lastPlanItems } : {}),
        });
        for (const ev of queue.drainNow()) yield ev;
        const cancelled = code === "cancelled";
        yield emit({
          type: "session.failed",
          error: {
            code,
            message: e.message ?? String(err),
            // Actionable recovery hint for every frontend; a user cancel
            // needs none (it is not a failure to recover from).
            ...(cancelled ? {} : { hint: classifyAgentError(err).hint }),
            // Genuine failures are recoverable: the session's file changes,
            // completed steps and checkpoints are preserved on disk, so the
            // user can `/resume <sessionId>`. A cancel is not a failure to
            // recover from. sessionId lets frontends print the exact command.
            ...(cancelled ? {} : { recoverable: true, sessionId }),
          },
        });
      } finally {
        // Stop routing provider retries onto this (now-ending) run's queue.
        if (deps.retryBus) deps.retryBus.emit = undefined;
        queue.end();
        dispatchManager?.disposeAll();
        // A caller-provided manager outlives the run (multi-turn sessions).
        if (!deps.background) ctx.background?.disposeAll();
        // Tear down the shared headless browser (browser_* tools) so a
        // Playwright process is not leaked past the session. No-op when the
        // browser was never launched; runs only for the top-level session.
        if (depth === 0) await disposeBrowser().catch(() => {});
        // Tear down any language-server sessions (lsp_* tools) for the same
        // reason — no spawned server process should outlive the session.
        if (depth === 0) await disposeLspServers().catch(() => {});
        // sessionEnd hooks fire once per top-level session, after cleanup.
        // Advisory only; never affects the (already emitted) outcome. Nested
        // subagent sessions (depth > 0) do not fire it.
        if (depth === 0) {
          await runHooks("sessionEnd", deps.hooks?.sessionEnd, {
            sessionId,
            workspace: input.projectPath,
            status: sessionEndStatus ?? "cancelled",
          });
        }
      }
      } finally {
        activeSessionRuns.delete(activeRunKey);
      }
    },
  };
}

class AgentLimitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
