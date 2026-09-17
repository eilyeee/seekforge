/**
 * The dispatch-family tool handlers (dispatch_agent / dispatch_team /
 * agent_result / agent_send) extracted from the runTask generator in loop.ts.
 *
 * Everything the handlers used to capture from runTask's closure arrives
 * through an explicit {@link DispatchRuntime}, which makes the surface between
 * the turn loop and subagent orchestration visible and keeps loop.ts focused
 * on the turn loop itself. `createCore` is injected (rather than importing
 * createAgentCore) so this module has no runtime dependency back on loop.ts.
 */
import { existsSync } from "node:fs";
import type { AgentEvent, FinalReport, PermissionRequest, TokenUsage, ToolResult } from "@seekforge/shared";
import type { ToolContext } from "../tools/index.js";
import {
  AGENT_REPORT_TOOL,
  AGENT_SEND_TOOL,
  AgentIsolationError,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DISPATCH_AGENT_TOOL,
  acquireAgentEditLock,
  buildPreloadedSkills,
  buildSubagentPrompt,
  copyAgentTranscript,
  createAgentWorktree,
  discardAgentWorktree,
  effortProviderOptions,
  resolveAgentHooks,
  resolveAgentRunPolicy,
  resolveAgentTools,
  settleAgentWorktree,
  tryAcquireAgentEditLock,
  validateAgentTeam,
  whitelistDispatcher,
  type AgentDefinition,
  type AgentRunPolicy,
  type AgentWorktree,
  type DispatchHooks,
  type DispatchManager,
  type IsolatedChangeOutcome,
  type TeamMemberPlan,
} from "../subagents/index.js";
import { runHooks } from "../hooks/index.js";
import { loadSkills } from "../skills/index.js";
import { onAbortOnce } from "../util/abort.js";
import { isRecord } from "../util/guards.js";
import { ZERO_USAGE, addUsage, subtractUsage } from "./loop-logic.js";
import type { AgentCore, RunAgentTaskInput } from "./index.js";
import type { AgentCoreDeps, ConfirmQueue } from "./loop.js";

/** Everything the dispatch handlers need from the surrounding runTask call. */
export type DispatchRuntime = {
  deps: AgentCoreDeps;
  input: RunAgentTaskInput;
  roster: AgentDefinition[];
  depth: number;
  confirmQueue: ConfirmQueue;
  sessionId: string;
  ctx: ToolContext;
  dispatchManager: DispatchManager;
  /** The parent run's aggregates, merged into as nested runs progress. */
  changedFiles: Set<string>;
  commandsRun: string[];
  pushEvent: (ev: AgentEvent) => void;
  confirmAllowed: (req: PermissionRequest) => Promise<boolean>;
  /** Parent-run cumulative usage; nested usage updates flow through these. */
  getUsage: () => TokenUsage;
  setUsage: (usage: TokenUsage) => void;
  /**
   * Widens a parent-RUN total to the parent SESSION total. Usage events
   * re-emitted from here carry both windows, exactly like the ones the loop
   * emits, so a resumed parent never publishes a run total as if it were the
   * session's.
   */
  toSessionUsage: (runUsage: TokenUsage) => TokenUsage;
  /** Keeps the parent run alive until a foreground or background dispatch cleans up. */
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
  /** loop.ts's createAgentCore, injected to avoid a module cycle. */
  createCore: (deps: AgentCoreDeps) => AgentCore;
  /**
   * True once the run that built these tools has ended while a session-scoped
   * manager keeps its background dispatches running. From then on nothing
   * reaches the ended run: events and usage wait for the next run, and no
   * permission prompt can be answered.
   */
  isDetached: () => boolean;
};

export type DispatchTools = {
  runDispatch(rawArgs: unknown, skipConfirm?: boolean): Promise<ToolResult>;
  runTeam(rawArgs: unknown): Promise<ToolResult>;
  handleAgentResult(rawArgs: unknown): ToolResult;
  runAgentSend(rawArgs: unknown): Promise<ToolResult>;
  emitDispatchTerminal(dispatchId: string, result: ToolResult): void;
};

/** Per-manager dispatch state that must outlive one run's tools (session-scoped managers). */
type IsolationState = {
  /** Dispatches that run isolated; agent_send keeps the choice. */
  isolated: Set<string>;
  /** Worktrees whose change was not applied; agent_send continues in them. */
  retained: Map<string, AgentWorktree>;
};
const isolationStates = new WeakMap<DispatchManager, IsolationState>();

function isolationStateOf(manager: DispatchManager): IsolationState {
  let state = isolationStates.get(manager);
  if (!state) {
    state = { isolated: new Set(), retained: new Map() };
    isolationStates.set(manager, state);
  }
  return state;
}

/** A plan-mode definition is read-only whatever its `mode` says. */
function effectiveMode(def: AgentDefinition): "ask" | "edit" {
  return def.permissionMode === "plan" ? "ask" : def.mode;
}

/** What an approval prompt says about a dispatch beyond its task. */
function dispatchTraits(def: AgentDefinition, policy: AgentRunPolicy, isolated: boolean): string {
  const traits: string[] = [];
  if (isolated) traits.push("isolated worktree");
  if (policy.denyPrompts) traits.push("never prompts");
  else if (def.permissionMode !== undefined && def.permissionMode !== "plan") {
    traits.push(`approval mode ${policy.approvalMode}`);
  }
  return traits.length > 0 ? ` (${traits.join(", ")})` : "";
}

function isolationData(outcome: IsolatedChangeOutcome): Record<string, unknown> {
  if (outcome.status === "retained") {
    return {
      status: "retained",
      reason: outcome.reason,
      message: outcome.message.slice(0, 500),
      files: outcome.files,
      worktree: outcome.worktree,
      branch: outcome.branch,
    };
  }
  return outcome.status === "applied" ? { status: "applied", files: outcome.files } : { status: "unchanged" };
}

export function createDispatchTools(rt: DispatchRuntime): DispatchTools {
  const { deps, input, roster, dispatchManager, confirmAllowed } = rt;
  const pushEvent = (ev: AgentEvent): void => {
    if (!rt.isDetached()) rt.pushEvent(ev);
  };
  const colorOf = (agentId: string): { color?: string } => {
    const color = roster.find((d) => d.id === agentId)?.color;
    return color !== undefined ? { color } : {};
  };
  const isolationState = isolationStateOf(dispatchManager);

  function resultSummary(result: ToolResult): string {
    if (!result.ok) return (result.error?.message ?? "subagent failed").slice(0, 500);
    const data = result.data as { report?: unknown } | undefined;
    if (typeof data?.report === "string") return data.report.replace(/\s+/g, " ").trim().slice(0, 500);
    return "completed";
  }

  function emitDispatchTerminal(dispatchId: string, result: ToolResult): void {
    if (rt.isDetached() || dispatchManager.terminalEmitted(dispatchId)) return;
    const rec = dispatchManager.get(dispatchId);
    if (!rec || rec.status === "running") return;
    dispatchManager.markTerminalEmitted(dispatchId);
    const base = {
      dispatchId,
      agentId: rec.agentId,
      task: rec.task,
      ...(rec.subSessionId !== undefined ? { subSessionId: rec.subSessionId } : {}),
      ...colorOf(rec.agentId),
    };
    if (rec.status === "cancelled") {
      pushEvent({
        type: "subagent.cancelled",
        ...base,
        status: "cancelled",
        reason: rec.cancelReason ?? result.error?.message ?? "dispatch cancelled",
      });
    } else if (rec.status === "failed") {
      pushEvent({
        type: "subagent.failed",
        ...base,
        status: "failed",
        error: {
          code: result.error?.code ?? "subagent_failed",
          message: result.error?.message ?? "subagent failed",
        },
        resultSummary: resultSummary(result),
      });
    } else {
      pushEvent({
        type: "subagent.completed",
        ...base,
        status: "done",
        resultSummary: resultSummary(result),
      });
    }
  }

  /**
   * `track` keeps the parent run alive until the dispatch settles; a
   * detachable background dispatch is not tracked, so the run may end first.
   */
  function observeDispatch(dispatchId: string, promise: Promise<ToolResult>, track = true): void {
    const observed = promise.then((result) => {
      emitDispatchTerminal(dispatchId, result);
      return result;
    });
    if (track) void rt.trackOperation(observed);
  }

  /** Skill bodies a definition preloads, resolved from the run's skill snapshot. */
  function preloadedSkills(def: AgentDefinition): string | undefined {
    if (!def.skills?.length) return undefined;
    try {
      return buildPreloadedSkills(
        def.skills,
        deps.skillSnapshot ?? loadSkills(input.projectPath, deps.pluginContributions),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Runs a subagent as a nested agent core (depth+1, no further
   * dispatch), forwards nested tool activity as step.started events
   * through the event queue, merges its usage/changes into the parent,
   * and resolves with the subagent's report as the tool result.
   * `signal` is the dispatch's own (manager-chained) abort signal: on
   * abort the nested run is abandoned immediately, even when it is
   * stuck inside a provider call.
   *
   * An edit run either holds the workspace edit lock for its whole run or,
   * when `isolated`, works in a managed worktree whose change is applied
   * through the parent's permission flow afterwards.
   */
  async function executeNestedRun(
    def: AgentDefinition,
    task: string,
    signal: AbortSignal,
    hooks: DispatchHooks,
    dispatchId: string,
    options: { resumeSessionId?: string; isolated: boolean; toolName: string },
  ): Promise<ToolResult> {
    const { resumeSessionId } = options;
    const policy = resolveAgentRunPolicy(def, { mode: input.mode, approvalMode: input.approvalMode });
    const allowedTools = resolveAgentTools(def, deps.dispatcher.list());
    const nestedHooks = resolveAgentHooks(def, deps.hooks);
    const effort = effortProviderOptions(def.effort);
    const provider =
      deps.providerForModel !== undefined && (def.model !== undefined || effort !== undefined)
        ? deps.providerForModel(def.model ?? deps.provider.model, effort)
        : deps.provider;

    let worktree: AgentWorktree | undefined;
    let retainedWorktree: AgentWorktree | undefined;
    let releaseEditLock: (() => void) | undefined;
    if (policy.mode === "edit" && options.isolated) {
      const retained = isolationState.retained.get(dispatchId);
      isolationState.retained.delete(dispatchId);
      if (retained !== undefined && existsSync(retained.projectPath)) retainedWorktree = retained;
      try {
        worktree = retainedWorktree ?? (await createAgentWorktree(input.projectPath, def.id));
      } catch (error) {
        if (!(error instanceof AgentIsolationError)) throw error;
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      if (resumeSessionId !== undefined && worktree !== retainedWorktree) {
        copyAgentTranscript(input.projectPath, worktree.projectPath, resumeSessionId);
      }
    } else if (policy.mode === "edit") {
      releaseEditLock = tryAcquireAgentEditLock(input.projectPath);
      if (releaseEditLock === undefined) {
        pushEvent({ type: "step.started", title: `[${def.id}] waiting for another edit agent to finish` });
        releaseEditLock = await acquireAgentEditLock(input.projectPath, signal);
      }
    }
    const runWorkspace = worktree?.projectPath ?? input.projectPath;

    let subSessionId: string | undefined;
    // A harness tool, so a `tools` whitelist keeps it; only disallowedTools removes it.
    const canReport = !def.disallowedTools?.includes(AGENT_REPORT_TOOL);
    const reportToParent = (raw: unknown): ToolResult => {
      const message = isRecord(raw) && typeof raw["message"] === "string" ? raw["message"] : "";
      const outcome = hooks.report(message);
      if (!outcome.ok) return { ok: false, error: { code: outcome.code, message: outcome.message } };
      hooks.onStep(AGENT_REPORT_TOOL);
      const delivered = dispatchManager.get(dispatchId)?.reports.at(-1) ?? message;
      pushEvent({
        type: "subagent.step",
        dispatchId,
        agentId: def.id,
        task,
        status: "running",
        toolName: AGENT_REPORT_TOOL,
        message: delivered,
        ...(subSessionId !== undefined ? { subSessionId } : {}),
        ...colorOf(def.id),
      });
      return { ok: true, data: { delivered: true, note: "the parent reads this at its next turn" } };
    };

    let events: AsyncIterator<AgentEvent>;
    try {
      const nested = rt.createCore({
        ...deps,
        provider,
        // dontAsk, and any prompt after the parent run ended, is answered "no":
        // no one is there to answer it.
        confirm: (req) => (policy.denyPrompts || rt.isDetached() ? Promise.resolve(false) : deps.confirm(req)),
        hooks: nestedHooks,
        subagents: undefined,
        dispatchManager: undefined,
        _depth: rt.depth + 1,
        _dispatchManager: undefined,
        _takeSubagentSteering: hooks.takeSteering,
        _reportToParent: canReport ? reportToParent : undefined,
        _confirmQueue: rt.confirmQueue,
        dispatcher: allowedTools ? whitelistDispatcher(deps.dispatcher, allowedTools) : deps.dispatcher,
        onModelDelta: undefined,
        extractMemory: false,
        askUser: undefined, // subagents must not block on user input
        limits: { ...deps.limits, maxAgentTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS },
      });
      events = nested
        .runTask({
          projectPath: runWorkspace,
          task,
          mode: policy.mode,
          approvalMode: policy.approvalMode,
          signal,
          systemPromptOverride: buildSubagentPrompt({ ...def, mode: policy.mode }, runWorkspace, {
            isolated: worktree !== undefined,
            canReport,
            skills: preloadedSkills(def),
          }),
          parentAgentId: def.id,
          // The guard belongs to the parent's checkout; a worktree is another workspace.
          ...(input.workspaceGuard && worktree === undefined ? { workspaceGuard: input.workspaceGuard } : {}),
          ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        })
        [Symbol.asyncIterator]();
    } catch (error) {
      // Nothing ran: hand the workspace back, and keep a retained worktree for
      // a later agent_send.
      releaseEditLock?.();
      if (worktree !== undefined) {
        if (worktree === retainedWorktree) isolationState.retained.set(dispatchId, worktree);
        else await discardAgentWorktree(input.projectPath, worktree);
      }
      throw error;
    }

    let nestedUsage = ZERO_USAGE;
    let report: FinalReport | undefined;
    let failure: { code: string; message: string } | undefined;
    let cancelled = false;

    const ABORTED = Symbol("dispatch-aborted");
    let offAbort: () => void = () => {};
    const abortPromise = new Promise<typeof ABORTED>((resolve) => {
      offAbort = onAbortOnce(signal, () => resolve(ABORTED));
    });

    try {
      for (;;) {
        const step = await Promise.race([events.next(), abortPromise]);
        if (step === ABORTED) {
          cancelled = true;
          // The nested run owns tools, hooks, and a session lease. Wait for its
          // generator cleanup before reporting cancellation to the parent.
          try {
            await events.return?.();
          } catch {
            // Cancellation remains authoritative even if cleanup reports an error.
          }
          break;
        }
        if (step.done) break;
        const ev = step.value;
        switch (ev.type) {
          case "session.created":
            subSessionId = ev.sessionId;
            hooks.onSubSession(ev.sessionId);
            break;
          case "tool.started":
            // agent_report surfaces through its own step, carrying the message.
            if (ev.toolName === AGENT_REPORT_TOOL) break;
            hooks.onStep(ev.toolName);
            // Keep the legacy step title for older clients while new
            // frontends consume the structured dispatch event below.
            pushEvent({ type: "step.started", title: `[${def.id}] ${ev.toolName}` });
            pushEvent({
              type: "subagent.step",
              dispatchId,
              agentId: def.id,
              task,
              status: "running",
              toolName: ev.toolName,
              ...(subSessionId !== undefined ? { subSessionId } : {}),
              ...colorOf(def.id),
            });
            break;
          case "file.changed":
            // An isolated run's paths name its worktree; the parent's checkout
            // changes only when the diff is applied below.
            if (worktree !== undefined) break;
            rt.changedFiles.add(ev.path);
            pushEvent({ type: "file.changed", path: ev.path });
            break;
          case "usage.updated": {
            // Account each cumulative update immediately. Background runs
            // may be aborted when the parent exits, so waiting for child
            // completion can otherwise lose already-billed usage.
            const delta = subtractUsage(ev.usage, nestedUsage);
            nestedUsage = ev.usage;
            if (rt.isDetached()) {
              dispatchManager.addDetachedUsage(delta);
              break;
            }
            const merged = addUsage(rt.getUsage(), delta);
            rt.setUsage(merged);
            pushEvent({ type: "usage.updated", usage: merged, sessionUsage: rt.toSessionUsage(merged) });
            break;
          }
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
      offAbort();
      releaseEditLock?.();
    }

    // The nested session has its own trace (separate sessionId); record
    // the parent linkage by logging the dispatch itself — unless the parent
    // run already ended and released its session.
    if (!rt.isDetached()) rt.ctx.log?.({ tool: DISPATCH_AGENT_TOOL, agentId: def.id, task, subSessionId });

    const succeeded = !cancelled && failure === undefined && report !== undefined;
    let isolated: IsolatedChangeOutcome | undefined;
    if (worktree !== undefined) {
      // The transcript outlives the worktree, so agent_send can resume it.
      if (subSessionId !== undefined) copyAgentTranscript(worktree.projectPath, input.projectPath, subSessionId);
      const detached = rt.isDetached();
      try {
        isolated = await settleAgentWorktree({
          workspace: input.projectPath,
          worktree,
          agentId: def.id,
          ctx: rt.ctx,
          toolName: options.toolName,
          signal,
          apply: succeeded && !detached,
          notAppliedReason: detached
            ? "the parent run ended before the change could be reviewed"
            : cancelled
              ? "the dispatch was cancelled"
              : "the agent run did not complete",
        });
      } catch (error) {
        isolated = {
          status: "retained",
          reason: "not_applied",
          message: error instanceof Error ? error.message : String(error),
          files: [],
          worktree: worktree.path,
          branch: worktree.branch,
        };
      }
      if (isolated.status === "retained") {
        isolationState.retained.set(dispatchId, worktree);
      } else if (isolated.status === "applied") {
        for (const file of isolated.files) {
          rt.changedFiles.add(file);
          pushEvent({ type: "file.changed", path: file });
        }
      }
    }

    // subagentStop: a dispatched run finished (sessionId = the parent's).
    await runHooks("subagentStop", nestedHooks?.subagentStop, {
      sessionId: rt.sessionId,
      workspace: input.projectPath,
      agentId: def.id,
      ok: succeeded,
    });

    const isolationField = isolated !== undefined ? { isolation: isolationData(isolated) } : {};
    if (cancelled) {
      return {
        ok: false,
        ...(isolated?.status === "retained" ? { data: isolationField } : {}),
        error: { code: "subagent_cancelled", message: "dispatch aborted" },
      };
    }

    if (failure || !report) {
      return {
        ok: false,
        ...(isolated?.status === "retained" ? { data: isolationField } : {}),
        error: {
          code: "subagent_failed",
          message: failure?.message ?? "subagent run produced no final report",
        },
      };
    }
    rt.commandsRun.push(...report.commandsRun);
    return {
      ok: true,
      data: {
        agentId: def.id,
        report: report.summary,
        // An isolated run changed the parent's checkout only by what was applied.
        changedFiles:
          isolated === undefined ? report.changedFiles : isolated.status === "applied" ? isolated.files : [],
        commandsRun: report.commandsRun,
        ...isolationField,
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
  async function runDispatch(rawArgs: unknown, skipConfirm = false): Promise<ToolResult> {
    const a = rawArgs as { agentId?: unknown; task?: unknown; background?: unknown; isolation?: unknown };
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
    if (a?.isolation !== undefined && a.isolation !== "worktree") {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: 'dispatch_agent isolation must be "worktree" when given' },
      };
    }
    const mode = effectiveMode(def);

    // A read-only parent run (ask / plan mode) must not gain write access
    // by delegating to an edit-mode agent — that would bypass the read-only
    // guarantee. Refuse the dispatch (the agent could still run read-only,
    // but we don't silently downgrade it; the model should pick an ask agent).
    if (input.mode === "ask" && mode === "edit") {
      return {
        ok: false,
        error: {
          code: "forbidden_in_ask_mode",
          message: `cannot dispatch edit-mode agent "${def.id}" from a read-only (ask/plan) session`,
        },
      };
    }
    const isolated = mode === "edit" && (a?.isolation === "worktree" || def.isolation === "worktree");
    const policy = resolveAgentRunPolicy(def, { mode: input.mode, approvalMode: input.approvalMode });

    // ask-mode agents are read-only and auto-allowed; edit-mode agents
    // go through the normal approval flow (unless approvalMode is auto).
    if (!skipConfirm && mode === "edit" && input.approvalMode !== "auto") {
      const approved = await confirmAllowed({
        toolName: DISPATCH_AGENT_TOOL,
        permission: "write",
        description: `Dispatch agent ${def.id}${dispatchTraits(def, policy, isolated)}: ${task.slice(0, 100)}`,
      });
      if (!approved) {
        return {
          ok: false,
          error: { code: "denied_by_user", message: `dispatch of agent "${def.id}" denied by user` },
        };
      }
    }

    const background = a?.background === true;
    // A session-scoped manager lets a background dispatch outlive this run,
    // so this run's cancellation must not reach it.
    const detachable = background && dispatchManager.sessionScoped;
    let dispatchId = "";
    const started = dispatchManager.start({
      agentId: def.id,
      task,
      background,
      ...(detachable ? {} : { signal: input.signal }),
      run: (signal, hooks) =>
        executeNestedRun(def, task, signal, hooks, dispatchId, { isolated, toolName: DISPATCH_AGENT_TOOL }),
    });
    dispatchId = started.id;
    if (isolated) isolationState.isolated.add(dispatchId);
    pushEvent({ type: "subagent.started", dispatchId, agentId: def.id, task, status: "running", ...colorOf(def.id) });
    observeDispatch(dispatchId, started.promise, !detachable);
    if (background) {
      return { ok: true, data: { dispatchId, agentId: def.id, status: "running" } };
    }
    return started.promise;
  }

  /** Executes a validated dependency graph through the normal dispatch lifecycle. */
  async function runTeam(rawArgs: unknown): Promise<ToolResult> {
    const validated = validateAgentTeam(rawArgs, roster);
    if (!validated.ok) {
      return { ok: false, error: { code: "invalid_team", message: validated.message } };
    }
    type MemberOutcome = {
      id: string;
      agentId: string;
      status: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
      result?: ToolResult;
      reason?: string;
    };
    const outcomes = new Map<string, MemberOutcome>(
      validated.plan.members.map((member) => [
        member.id,
        { id: member.id, agentId: member.agentId, status: "pending" },
      ]),
    );
    const running = new Map<string, Promise<{ member: TeamMemberPlan; result: ToolResult }>>();
    let stopped = false;
    while ([...outcomes.values()].some((outcome) => outcome.status === "pending" || outcome.status === "running")) {
      for (const member of validated.plan.members) {
        const outcome = outcomes.get(member.id)!;
        if (outcome.status !== "pending") continue;
        const dependencies = member.dependsOn.map((id) => outcomes.get(id)!);
        if (
          dependencies.some((dep) => dep.status === "failed" || dep.status === "cancelled" || dep.status === "skipped")
        ) {
          outcome.status = "skipped";
          outcome.reason = "dependency failed";
        }
      }
      if (stopped) {
        for (const outcome of outcomes.values()) {
          if (outcome.status === "pending") {
            outcome.status = "skipped";
            outcome.reason = "team stopped after a member failure";
          }
        }
      }
      while (!stopped && running.size < validated.plan.maxConcurrency) {
        const editRunning = [...running.keys()].some((id) => {
          const runningMember = validated.plan.members.find((candidate) => candidate.id === id)!;
          return effectiveMode(roster.find((candidate) => candidate.id === runningMember.agentId)!) === "edit";
        });
        const member = validated.plan.members.find((candidate) => {
          const outcome = outcomes.get(candidate.id)!;
          if (outcome.status !== "pending" || !candidate.dependsOn.every((id) => outcomes.get(id)!.status === "done")) {
            return false;
          }
          const candidateMode = effectiveMode(roster.find((definition) => definition.id === candidate.agentId)!);
          return candidateMode !== "edit" || !editRunning;
        });
        if (!member) break;

        const def = roster.find((candidate) => candidate.id === member.agentId)!;
        if (input.mode === "edit" && effectiveMode(def) === "edit" && input.approvalMode !== "auto") {
          // Frontends expose one interactive permission slot per run. Ask
          // serially, then launch approved members with normal concurrency.
          const policy = resolveAgentRunPolicy(def, { mode: input.mode, approvalMode: input.approvalMode });
          const approved = await confirmAllowed({
            toolName: DISPATCH_AGENT_TOOL,
            permission: "write",
            description: `Dispatch agent ${def.id}${dispatchTraits(def, policy, def.isolation === "worktree")}: ${member.task.slice(0, 100)}`,
          });
          if (!approved) {
            const outcome = outcomes.get(member.id)!;
            outcome.status = "failed";
            outcome.result = {
              ok: false,
              error: { code: "denied_by_user", message: `dispatch of agent "${def.id}" denied by user` },
            };
            if (validated.plan.failurePolicy === "stop") stopped = true;
            continue;
          }
        }

        outcomes.get(member.id)!.status = "running";
        const promise = runDispatch({ agentId: member.agentId, task: member.task }, true).then(
          (result) => ({ member, result }),
          (err: unknown) => ({
            member,
            result: {
              ok: false,
              error: { code: "subagent_failed", message: err instanceof Error ? err.message : String(err) },
            },
          }),
        );
        running.set(member.id, promise);
      }

      if (running.size === 0) continue;
      const { member, result } = await Promise.race(running.values());
      running.delete(member.id);
      const outcome = outcomes.get(member.id)!;
      outcome.status = result.ok ? "done" : result.error?.code === "subagent_cancelled" ? "cancelled" : "failed";
      outcome.result = result;
      if (!result.ok && validated.plan.failurePolicy === "stop") {
        stopped = true;
      }
    }
    const members = validated.plan.members.map((member) => outcomes.get(member.id)!);
    const failed = members.filter((member) => member.status === "failed");
    const cancelled = members.filter((member) => member.status === "cancelled");
    if (failed.length > 0) {
      return {
        ok: false,
        data: { status: "failed", members },
        error: { code: "team_failed", message: `${failed.length} team member(s) failed` },
      };
    }
    if (cancelled.length > 0) {
      return {
        ok: false,
        data: { status: "cancelled", members },
        error: { code: "team_cancelled", message: `${cancelled.length} team member(s) cancelled` },
      };
    }
    return { ok: true, data: { status: "done", members } };
  }

  /** Handles an agent_result tool call (synchronous status poll). */
  function handleAgentResult(rawArgs: unknown): ToolResult {
    const a = rawArgs as { dispatchId?: unknown };
    const dispatchId = typeof a?.dispatchId === "string" ? a.dispatchId : "";
    const rec = dispatchId ? dispatchManager.get(dispatchId) : undefined;
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
      return {
        ok: true,
        data: {
          status: "running",
          agentId: rec.agentId,
          steps: rec.steps.slice(-10),
          ...(rec.reports.length > 0 ? { reports: rec.reports.slice(-5) } : {}),
        },
      };
    }
    dispatchManager.markDelivered(dispatchId);
    const isolationField = (rec.result?.data as { isolation?: unknown } | undefined)?.isolation;
    if (rec.status === "failed") {
      return {
        ok: false,
        ...(isolationField !== undefined ? { data: { isolation: isolationField } } : {}),
        error: { code: "subagent_failed", message: rec.result?.error?.message ?? "subagent run failed" },
      };
    }
    if (rec.status === "cancelled") {
      return {
        ok: false,
        ...(isolationField !== undefined ? { data: { isolation: isolationField } } : {}),
        error: { code: "subagent_cancelled", message: rec.cancelReason ?? "subagent was cancelled" },
      };
    }
    const data = rec.result?.data as { report?: string; changedFiles?: string[]; commandsRun?: string[] } | undefined;
    return {
      ok: true,
      data: {
        status: "done",
        report: data?.report ?? "",
        changedFiles: data?.changedFiles ?? [],
        commandsRun: data?.commandsRun ?? [],
        ...(isolationField !== undefined ? { isolation: isolationField } : {}),
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
    const rec = dispatchManager.get(dispatchId);
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
    const mode = effectiveMode(def);
    if (input.mode === "ask" && mode === "edit") {
      return {
        ok: false,
        error: {
          code: "forbidden_in_ask_mode",
          message: `cannot dispatch edit-mode agent "${def.id}" from a read-only (ask/plan) session`,
        },
      };
    }
    if (rec.status !== "done" || rec.subSessionId === undefined) {
      return {
        ok: false,
        error: {
          code: "subagent_failed",
          message: `dispatch ${dispatchId} failed; start a fresh dispatch_agent instead`,
        },
      };
    }
    const isolated = mode === "edit" && isolationState.isolated.has(dispatchId);
    const policy = resolveAgentRunPolicy(def, { mode: input.mode, approvalMode: input.approvalMode });
    if (mode === "edit" && input.approvalMode !== "auto") {
      const approved = await confirmAllowed({
        toolName: AGENT_SEND_TOOL,
        permission: "write",
        description: `Dispatch agent ${def.id}${dispatchTraits(def, policy, isolated)}: ${task.slice(0, 100)}`,
      });
      if (!approved) {
        return {
          ok: false,
          error: { code: "denied_by_user", message: `dispatch of agent "${def.id}" denied by user` },
        };
      }
    }
    const resumeSessionId = rec.subSessionId;
    const promise = dispatchManager.resume({
      id: dispatchId,
      task,
      signal: input.signal,
      run: (signal, hooks) =>
        executeNestedRun(def, task, signal, hooks, dispatchId, {
          resumeSessionId,
          isolated,
          toolName: AGENT_SEND_TOOL,
        }),
    });
    pushEvent({ type: "subagent.started", dispatchId, agentId: def.id, task, status: "running", ...colorOf(def.id) });
    observeDispatch(dispatchId, promise);
    return promise;
  }

  return { runDispatch, runTeam, handleAgentResult, runAgentSend, emitDispatchTerminal };
}
