import {
  DEFAULT_LIMITS,
  type AgentEvent,
  type AgentLimits,
  type ChatMessage,
  type FinalReport,
  type PermissionRequest,
  type TokenUsage,
  type ToolResult,
} from "@seekforge/shared";
import type { ChatProvider } from "../provider/index.js";
import type { RuntimeClient } from "../runtime/index.js";
import { createBackgroundTasks, type ToolContext, type ToolDispatcher } from "../tools/index.js";
import { buildMemoryBrief, extractMemoryFromSession } from "../memory/index.js";
import { buildSkillBrief, loadSkills, logSkillUsage, selectSkills } from "../skills/index.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DISPATCH_AGENT_TOOL,
  buildDispatchToolDefinition,
  buildSubagentPrompt,
  buildSubagentRoster,
  whitelistDispatcher,
  type AgentDefinition,
} from "../subagents/index.js";
import { compactMessages } from "./context.js";
import { buildSystemPrompt } from "./prompt.js";
import { collectProjectRules } from "./rules.js";
import { appendCheckpoint, createSessionTrace, loadSessionMessages, newSessionId, readCheckpoints, writeSessionMeta } from "./trace.js";
import type { AgentCore, RunAgentTaskInput } from "./index.js";

export type AgentCoreDeps = {
  provider: ChatProvider;
  dispatcher: ToolDispatcher;
  /** Asks the user for permission; must surface the raw command/path. */
  confirm: (req: PermissionRequest) => Promise<boolean>;
  limits?: Partial<AgentLimits>;
  /** Model context window in tokens. DeepSeek: 128K. */
  contextWindowTokens?: number;
  /** When set, model output is streamed through this callback (chatStream). */
  onModelDelta?: (chunk: string) => void;
  /** Post-task memory extraction (one extra model call) for edit sessions. */
  extractMemory?: boolean;
  /** Rust execution backend; passed through to tools via ToolContext. */
  runtime?: RuntimeClient;
  /** Extra command prefixes the user allows to auto-run (L2). */
  commandAllowlist?: string[];
  /** Specialist agents dispatchable via the synthetic dispatch_agent tool. */
  subagents?: AgentDefinition[];
  /** Internal: nesting depth. Depth > 0 never advertises dispatch_agent. */
  _depth?: number;
};

const OUTPUT_RESERVE_TOKENS = 8192;

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

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const windowTokens = deps.contextWindowTokens ?? 131_072;
  const budgetTokens = Math.floor(windowTokens * limits.contextBudgetRatio) - OUTPUT_RESERVE_TOKENS;
  const depth = deps._depth ?? 0;
  // dispatch_agent is only advertised at depth 0 — dispatched runs never recurse.
  const roster: AgentDefinition[] = depth === 0 ? (deps.subagents ?? []) : [];

  return {
    async *runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent> {
      const resuming = input.resumeSessionId !== undefined;
      const sessionId = input.resumeSessionId ?? newSessionId();
      const trace = createSessionTrace(input.projectPath, sessionId);
      const emit = (e: AgentEvent): AgentEvent => {
        trace.event(e);
        return e;
      };

      yield emit({ type: "session.created", sessionId });

      const startedAt = new Date().toISOString();
      const meta = {
        id: sessionId,
        task: input.task,
        mode: input.mode,
        createdAt: startedAt,
        ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      };
      writeSessionMeta(input.projectPath, { ...meta, status: "running", updatedAt: startedAt });

      let messages: ChatMessage[];
      if (resuming) {
        messages = loadSessionMessages(input.projectPath, sessionId);
        // Rebuild the system prompt for the resumed run: the mode may have
        // changed (plan -> execute) and memory approved since the original
        // run should apply. Costs one prefix-cache miss; correctness first.
        if (messages[0]?.role === "system") {
          messages[0] = {
            role: "system",
            content:
              input.systemPromptOverride ??
              buildSystemPrompt({
                workspace: input.projectPath,
                mode: input.mode,
                plan: input.plan,
                projectRules: collectProjectRules(input.projectPath),
                memoryBrief: buildMemoryBrief(input.projectPath, input.task),
                subagentRoster: roster.length > 0 ? buildSubagentRoster(roster) : undefined,
              }),
          };
        }
        const continuation: ChatMessage = { role: "user", content: input.task };
        messages.push(continuation);
        trace.message(continuation);
      } else if (input.systemPromptOverride !== undefined) {
        // Internal: dispatched subagent runs replace the regular system
        // prompt (and skip skill selection — the definition is the procedure).
        messages = [
          { role: "system", content: input.systemPromptOverride },
          { role: "user", content: input.task },
        ];
        for (const m of messages) trace.message(m);
      } else {
        const memoryBrief = buildMemoryBrief(input.projectPath, input.task);
        const skillSelections = selectSkills(input.task, loadSkills(input.projectPath), {
          workspace: input.projectPath,
        });
        if (skillSelections.length > 0) {
          logSkillUsage(input.projectPath, sessionId, skillSelections);
          yield emit({
            type: "step.started",
            title: `skills: ${skillSelections.map((s) => s.skill.id).join(", ")}`,
          });
        }
        const systemPrompt = buildSystemPrompt({
          workspace: input.projectPath,
          mode: input.mode,
          plan: input.plan,
          projectRules: collectProjectRules(input.projectPath),
          memoryBrief,
          skillBrief: buildSkillBrief(skillSelections),
          subagentRoster: roster.length > 0 ? buildSubagentRoster(roster) : undefined,
        });
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.task },
        ];
        for (const m of messages) trace.message(m);
      }

      const throwIfCancelled = () => {
        if (input.signal?.aborted) {
          throw new AgentLimitError("cancelled", "cancelled by user");
        }
      };

      // First-wins checkpointing: on resume, pre-seed from the existing file so
      // the original run's pre-session snapshots stay authoritative.
      const checkpointed = new Set<string>(
        resuming ? readCheckpoints(input.projectPath, sessionId).map((c) => c.path) : [],
      );
      const ctx: ToolContext = {
        sessionId,
        workspace: input.projectPath,
        policy: {
          approvalMode: input.approvalMode,
          mode: input.mode,
          commandAllowlist: deps.commandAllowlist ?? [],
        },
        confirm: deps.confirm,
        log: (entry) => trace.toolCall(entry),
        runtime: deps.runtime,
        background: createBackgroundTasks(),
        checkpoint: (path, before) => {
          if (checkpointed.has(path)) return;
          checkpointed.add(path);
          appendCheckpoint(input.projectPath, sessionId, { ts: new Date().toISOString(), path, before });
        },
      };

      const toolDefs =
        roster.length > 0
          ? [...deps.dispatcher.list(), buildDispatchToolDefinition(roster)]
          : deps.dispatcher.list();
      let usage = ZERO_USAGE;
      let toolCallCount = 0;
      const changedFiles = new Set<string>();
      const commandsRun: string[] = [];
      let finalContent: string | undefined;

      /**
       * Handles a dispatch_agent tool call: runs the named subagent as a
       * nested agent core (depth+1, no further dispatch), forwards nested
       * tool activity as step.started events, merges its usage/changes into
       * the parent, and returns the subagent's report as the tool result.
       */
      async function* runDispatch(rawArgs: unknown): AsyncGenerator<AgentEvent, ToolResult> {
        const a = rawArgs as { agentId?: unknown; task?: unknown };
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
          const approved = await deps.confirm({
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

        const nested = createAgentCore({
          ...deps,
          subagents: undefined,
          _depth: depth + 1,
          dispatcher: def.tools ? whitelistDispatcher(deps.dispatcher, def.tools) : deps.dispatcher,
          onModelDelta: undefined,
          extractMemory: false,
          limits: { ...deps.limits, maxAgentTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS },
        });

        let subSessionId: string | undefined;
        let nestedUsage: TokenUsage | undefined;
        let report: FinalReport | undefined;
        let failure: { code: string; message: string } | undefined;

        for await (const ev of nested.runTask({
          projectPath: input.projectPath,
          task,
          mode: def.mode,
          approvalMode: input.approvalMode,
          signal: input.signal,
          systemPromptOverride: buildSubagentPrompt(def, input.projectPath),
          parentAgentId: def.id,
        })) {
          switch (ev.type) {
            case "session.created":
              subSessionId = ev.sessionId;
              break;
            case "tool.started":
              // Cheap visibility into the nested run without new event types.
              yield emit({ type: "step.started", title: `[${def.id}] ${ev.toolName}` });
              break;
            case "file.changed":
              changedFiles.add(ev.path);
              yield emit({ type: "file.changed", path: ev.path });
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

        // The nested session has its own trace (separate sessionId); record
        // the parent linkage by logging the dispatch itself.
        ctx.log?.({ tool: DISPATCH_AGENT_TOOL, agentId: def.id, task, subSessionId });

        if (nestedUsage) {
          usage = addUsage(usage, nestedUsage);
          yield emit({ type: "usage.updated", usage });
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

      try {
        for (let turn = 0; turn < limits.maxAgentTurns; turn++) {
          throwIfCancelled();
          const compacted = compactMessages(messages, budgetTokens);
          if (compacted) {
            messages = compacted.messages;
            yield emit({
              type: "context.compacted",
              droppedTurns: compacted.droppedTurns,
              summaryTokens: compacted.summaryTokens,
            });
          }

          const res = deps.onModelDelta
            ? await deps.provider.chatStream({ messages, tools: toolDefs }, deps.onModelDelta)
            : await deps.provider.chat({ messages, tools: toolDefs });
          usage = addUsage(usage, res.usage);
          yield emit({ type: "usage.updated", usage });

          if (res.content) yield emit({ type: "model.message", content: res.content });

          if (res.toolCalls.length === 0) {
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

          for (const tc of res.toolCalls) {
            throwIfCancelled();
            toolCallCount++;
            if (toolCallCount > limits.maxToolCalls) {
              throw new AgentLimitError("max_tool_calls_exceeded", `exceeded ${limits.maxToolCalls} tool calls`);
            }

            let args: unknown = {};
            let result: ToolResult;
            let parseFailed = false;
            try {
              args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {};
            } catch {
              parseFailed = true;
              result = {
                ok: false,
                error: { code: "invalid_json", message: "tool call arguments were not valid JSON" },
              };
            }

            yield emit({ type: "tool.started", toolName: tc.name, args });
            if (!parseFailed) {
              if (roster.length > 0 && tc.name === DISPATCH_AGENT_TOOL) {
                result = yield* runDispatch(args);
              } else {
                result = await deps.dispatcher.execute({ id: tc.id, name: tc.name, arguments: args }, ctx);
              }
            }
            yield emit({ type: "tool.completed", toolName: tc.name, result: result! });

            if (result!.ok && result!.meta?.path && (tc.name === "apply_patch" || tc.name === "write_file")) {
              changedFiles.add(result!.meta.path);
              yield emit({ type: "file.changed", path: result!.meta.path });
            }
            if (tc.name === "run_command" && result!.meta?.command) {
              commandsRun.push(result!.meta.command);
            }

            const toolMsg: ChatMessage = {
              role: "tool",
              content: toolResultForModel(result!, limits.toolOutputMaxChars),
              toolCallId: tc.id,
            };
            messages.push(toolMsg);
            trace.message(toolMsg);
          }
        }

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
          usage,
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
            });
            yield emit({ type: "step.completed", title: "extracting memory" });
          } catch {
            // memory extraction must never fail the session
          }
        }

        yield emit({ type: "session.completed", report });
      } catch (err) {
        const e = err as Partial<AgentLimitError> & Error;
        const code = e.code ?? "agent_error";
        writeSessionMeta(input.projectPath, {
          ...meta,
          status: code === "cancelled" ? "cancelled" : "failed",
          updatedAt: new Date().toISOString(),
          usage,
        });
        yield emit({
          type: "session.failed",
          error: { code, message: e.message ?? String(err) },
        });
      } finally {
        ctx.background?.disposeAll();
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
