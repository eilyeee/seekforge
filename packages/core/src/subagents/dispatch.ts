import type { ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import type { ToolContext, ToolDispatcher } from "../tools/index.js";
import type { AgentDefinition } from "./types.js";

/** Synthetic tool name the loop intercepts (never reaches a dispatcher). */
export const DISPATCH_AGENT_TOOL = "dispatch_agent";

/** Synthetic tool: poll a (background) dispatch for status/report. */
export const AGENT_RESULT_TOOL = "agent_result";

/** Synthetic tool: continue a completed dispatch with a follow-up task. */
export const AGENT_SEND_TOOL = "agent_send";

/** Builds the synthetic dispatch_agent tool definition for the roster. */
export function buildDispatchToolDefinition(defs: AgentDefinition[]): ToolDefinitionForModel {
  const lines = defs.map((d) => `${d.id} — ${d.description || d.name} (${d.mode})`);
  return {
    name: DISPATCH_AGENT_TOOL,
    description:
      "Delegate a bounded sub-task to a specialist agent. It runs autonomously and " +
      "reports back; you stay responsible for the final result. Available agents:\n" +
      lines.join("\n"),
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          enum: defs.map((d) => d.id),
          description: "Which specialist agent to dispatch.",
        },
        task: {
          type: "string",
          description: "Self-contained sub-task description, including the expected report.",
        },
        background: {
          type: "boolean",
          description: "Start the agent and return immediately; poll with agent_result.",
        },
      },
      required: ["agentId", "task"],
    },
  };
}

/** Builds the synthetic agent_result tool definition (dispatch polling). */
export function buildAgentResultToolDefinition(): ToolDefinitionForModel {
  return {
    name: AGENT_RESULT_TOOL,
    description:
      "Check on a dispatched agent (e.g. one started with background:true). " +
      "Returns its status and recent steps while running, or its report once done.",
    parameters: {
      type: "object",
      properties: {
        dispatchId: {
          type: "string",
          description: 'Dispatch id returned by dispatch_agent (e.g. "ag-1").',
        },
      },
      required: ["dispatchId"],
    },
  };
}

/** Builds the synthetic agent_send tool definition (dispatch continuation). */
export function buildAgentSendToolDefinition(): ToolDefinitionForModel {
  return {
    name: AGENT_SEND_TOOL,
    description:
      "Send a follow-up task to a previously dispatched agent. It resumes with its " +
      "full prior context and reports back. Only valid once the dispatch completed.",
    parameters: {
      type: "object",
      properties: {
        dispatchId: {
          type: "string",
          description: 'Dispatch id returned by dispatch_agent (e.g. "ag-1").',
        },
        task: {
          type: "string",
          description: "Follow-up task for the agent, building on its previous run.",
        },
      },
      required: ["dispatchId", "task"],
    },
  };
}

/** One-line-per-agent roster for the parent system prompt. */
export function buildSubagentRoster(defs: AgentDefinition[]): string {
  return defs
    .map((d) => {
      const triggers = d.triggers.length > 0 ? ` triggers: ${d.triggers.join(", ")}` : "";
      return `- ${d.id} (${d.mode}) — ${d.description || d.name}${triggers}`;
    })
    .join("\n");
}

/**
 * Restricts a dispatcher to a tool-name whitelist: list() is filtered and
 * executing a non-whitelisted tool fails with "tool_not_allowed".
 */
export function whitelistDispatcher(inner: ToolDispatcher, allowed: string[]): ToolDispatcher {
  const set = new Set(allowed);
  return {
    list: () => inner.list().filter((d) => set.has(d.name)),
    execute: async (call, ctx: ToolContext): Promise<ToolResult> => {
      if (!set.has(call.name)) {
        return {
          ok: false,
          error: { code: "tool_not_allowed", message: `tool "${call.name}" is not allowed for this agent` },
        };
      }
      return inner.execute(call, ctx);
    },
  };
}
