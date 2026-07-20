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
import type { AgentEvent, FinalReport, PermissionRequest, TokenUsage, ToolResult } from "@seekforge/shared";
import type { ToolContext } from "../tools/index.js";
import {
  AGENT_SEND_TOOL,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DISPATCH_AGENT_TOOL,
  buildSubagentPrompt,
  validateAgentTeam,
  whitelistDispatcher,
  type AgentDefinition,
  type DispatchHooks,
  type DispatchManager,
  type TeamMemberPlan,
} from "../subagents/index.js";
import { runHooks } from "../hooks/index.js";
import { onAbortOnce } from "../util/abort.js";
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
  /** Keeps the parent run alive until a foreground or background dispatch cleans up. */
  trackOperation: <T>(operation: Promise<T>) => Promise<T>;
  /** loop.ts's createAgentCore, injected to avoid a module cycle. */
  createCore: (deps: AgentCoreDeps) => AgentCore;
};

export type DispatchTools = {
  runDispatch(rawArgs: unknown, skipConfirm?: boolean): Promise<ToolResult>;
  runTeam(rawArgs: unknown): Promise<ToolResult>;
  handleAgentResult(rawArgs: unknown): ToolResult;
  runAgentSend(rawArgs: unknown): Promise<ToolResult>;
  emitDispatchTerminal(dispatchId: string, result: ToolResult): void;
};

export function createDispatchTools(rt: DispatchRuntime): DispatchTools {
  const { deps, input, roster, dispatchManager, pushEvent, confirmAllowed } = rt;
  const terminalDispatches = new Set<string>();

  function resultSummary(result: ToolResult): string {
    if (!result.ok) return (result.error?.message ?? "subagent failed").slice(0, 500);
    const data = result.data as { report?: unknown } | undefined;
    if (typeof data?.report === "string") return data.report.replace(/\s+/g, " ").trim().slice(0, 500);
    return "completed";
  }

  function emitDispatchTerminal(dispatchId: string, result: ToolResult): void {
    if (terminalDispatches.has(dispatchId)) return;
    const rec = dispatchManager.get(dispatchId);
    if (!rec || rec.status === "running") return;
    terminalDispatches.add(dispatchId);
    const base = {
      dispatchId,
      agentId: rec.agentId,
      task: rec.task,
      ...(rec.subSessionId !== undefined ? { subSessionId: rec.subSessionId } : {}),
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

  function observeDispatch(dispatchId: string, promise: Promise<ToolResult>): void {
    terminalDispatches.delete(dispatchId);
    void rt.trackOperation(
      promise.then((result) => {
        emitDispatchTerminal(dispatchId, result);
        return result;
      }),
    );
  }

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
    dispatchId: string,
    resumeSessionId?: string,
  ): Promise<ToolResult> {
    const nested = rt.createCore({
      ...deps,
      provider: def.model !== undefined && deps.providerForModel ? deps.providerForModel(def.model) : deps.provider,
      subagents: undefined,
      dispatchManager: undefined,
      _depth: rt.depth + 1,
      _dispatchManager: undefined,
      _takeSubagentSteering: hooks.takeSteering,
      _confirmQueue: rt.confirmQueue,
      dispatcher: def.tools ? whitelistDispatcher(deps.dispatcher, def.tools) : deps.dispatcher,
      onModelDelta: undefined,
      extractMemory: false,
      askUser: undefined, // subagents must not block on user input
      limits: { ...deps.limits, maxAgentTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS },
    });

    let subSessionId: string | undefined;
    let nestedUsage = ZERO_USAGE;
    let report: FinalReport | undefined;
    let failure: { code: string; message: string } | undefined;
    let cancelled = false;

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
            });
            break;
          case "file.changed":
            rt.changedFiles.add(ev.path);
            pushEvent({ type: "file.changed", path: ev.path });
            break;
          case "usage.updated": {
            // Account each cumulative update immediately. Background runs
            // may be aborted when the parent exits, so waiting for child
            // completion can otherwise lose already-billed usage.
            const merged = addUsage(rt.getUsage(), subtractUsage(ev.usage, nestedUsage));
            rt.setUsage(merged);
            nestedUsage = ev.usage;
            pushEvent({ type: "usage.updated", usage: merged });
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
    }

    // The nested session has its own trace (separate sessionId); record
    // the parent linkage by logging the dispatch itself.
    rt.ctx.log?.({ tool: DISPATCH_AGENT_TOOL, agentId: def.id, task, subSessionId });

    // subagentStop: a dispatched run finished (sessionId = the parent's).
    await runHooks("subagentStop", deps.hooks?.subagentStop, {
      sessionId: rt.sessionId,
      workspace: input.projectPath,
      agentId: def.id,
      ok: !cancelled && failure === undefined && report !== undefined,
    });

    if (cancelled) {
      return { ok: false, error: { code: "subagent_cancelled", message: "dispatch aborted" } };
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
    rt.commandsRun.push(...report.commandsRun);
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
  async function runDispatch(rawArgs: unknown, skipConfirm = false): Promise<ToolResult> {
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
    if (!skipConfirm && def.mode === "edit" && input.approvalMode !== "auto") {
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

    let dispatchId = "";
    const started = dispatchManager.start({
      agentId: def.id,
      task,
      signal: input.signal,
      run: (signal, hooks) => executeNestedRun(def, task, signal, hooks, dispatchId),
    });
    dispatchId = started.id;
    pushEvent({ type: "subagent.started", dispatchId, agentId: def.id, task, status: "running" });
    observeDispatch(dispatchId, started.promise);
    if (a?.background === true) {
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
          return roster.find((candidate) => candidate.id === runningMember.agentId)!.mode === "edit";
        });
        const member = validated.plan.members.find((candidate) => {
          const outcome = outcomes.get(candidate.id)!;
          if (outcome.status !== "pending" || !candidate.dependsOn.every((id) => outcomes.get(id)!.status === "done")) {
            return false;
          }
          const candidateMode = roster.find((definition) => definition.id === candidate.agentId)!.mode;
          return candidateMode !== "edit" || !editRunning;
        });
        if (!member) break;

        const def = roster.find((candidate) => candidate.id === member.agentId)!;
        if (input.mode === "edit" && def.mode === "edit" && input.approvalMode !== "auto") {
          // Frontends expose one interactive permission slot per run. Ask
          // serially, then launch approved members with normal concurrency.
          const approved = await confirmAllowed({
            toolName: DISPATCH_AGENT_TOOL,
            permission: "write",
            description: `Dispatch agent ${def.id}: ${member.task.slice(0, 100)}`,
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
      return { ok: true, data: { status: "running", agentId: rec.agentId, steps: rec.steps.slice(-10) } };
    }
    if (rec.status === "failed") {
      return {
        ok: false,
        error: { code: "subagent_failed", message: rec.result?.error?.message ?? "subagent run failed" },
      };
    }
    if (rec.status === "cancelled") {
      return {
        ok: false,
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
    if (input.mode === "ask" && def.mode === "edit") {
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
    const promise = dispatchManager.resume({
      id: dispatchId,
      task,
      signal: input.signal,
      run: (signal, hooks) => executeNestedRun(def, task, signal, hooks, dispatchId, resumeSessionId),
    });
    pushEvent({ type: "subagent.started", dispatchId, agentId: def.id, task, status: "running" });
    observeDispatch(dispatchId, promise);
    return promise;
  }

  return { runDispatch, runTeam, handleAgentResult, runAgentSend, emitDispatchTerminal };
}
