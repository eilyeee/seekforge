import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import type { ToolContext, ToolDispatcher } from "../tools/index.js";
import { compactMessages } from "./context.js";
import { buildSystemPrompt } from "./prompt.js";
import { createSessionTrace, newSessionId } from "./trace.js";
import type { AgentCore, RunAgentTaskInput } from "./index.js";

export type AgentCoreDeps = {
  provider: ChatProvider;
  dispatcher: ToolDispatcher;
  /** Asks the user for permission; must surface the raw command/path. */
  confirm: (req: PermissionRequest) => Promise<boolean>;
  limits?: Partial<AgentLimits>;
  /** Model context window in tokens. DeepSeek: 128K. */
  contextWindowTokens?: number;
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

function readProjectRules(workspace: string): string | undefined {
  try {
    return readFileSync(join(workspace, "AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const windowTokens = deps.contextWindowTokens ?? 131_072;
  const budgetTokens = Math.floor(windowTokens * limits.contextBudgetRatio) - OUTPUT_RESERVE_TOKENS;

  return {
    async *runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent> {
      const sessionId = newSessionId();
      const trace = createSessionTrace(input.projectPath, sessionId);
      const emit = (e: AgentEvent): AgentEvent => {
        trace.event(e);
        return e;
      };

      yield emit({ type: "session.created", sessionId });

      const systemPrompt = buildSystemPrompt({
        workspace: input.projectPath,
        mode: input.mode,
        projectRules: readProjectRules(input.projectPath),
      });

      let messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.task },
      ];
      for (const m of messages) trace.message(m);

      const ctx: ToolContext = {
        sessionId,
        workspace: input.projectPath,
        policy: { approvalMode: input.approvalMode, mode: input.mode, commandAllowlist: [] },
        confirm: deps.confirm,
        log: (entry) => trace.toolCall(entry),
      };

      const toolDefs = deps.dispatcher.list();
      let usage = ZERO_USAGE;
      let toolCallCount = 0;
      const changedFiles = new Set<string>();
      const commandsRun: string[] = [];
      let finalContent: string | undefined;

      try {
        for (let turn = 0; turn < limits.maxAgentTurns; turn++) {
          const compacted = compactMessages(messages, budgetTokens);
          if (compacted) {
            messages = compacted.messages;
            yield emit({
              type: "context.compacted",
              droppedTurns: compacted.droppedTurns,
              summaryTokens: compacted.summaryTokens,
            });
          }

          const res = await deps.provider.chat({ messages, tools: toolDefs });
          usage = addUsage(usage, res.usage);
          yield emit({ type: "usage.updated", usage });

          if (res.content) yield emit({ type: "model.message", content: res.content });

          if (res.toolCalls.length === 0) {
            finalContent = res.content;
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
              result = await deps.dispatcher.execute({ id: tc.id, name: tc.name, arguments: args }, ctx);
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
        yield emit({ type: "session.completed", report });
      } catch (err) {
        const e = err as Partial<AgentLimitError> & Error;
        yield emit({
          type: "session.failed",
          error: { code: e.code ?? "agent_error", message: e.message ?? String(err) },
        });
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
