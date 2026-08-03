import type { ChatMessage, ConfirmResult, PermissionRequest, TokenUsage } from "@seekforge/shared";
import { McpError } from "./errors.js";
import type {
  ElicitationField,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResult,
  SamplingHandler,
  SamplingRequest,
  SamplingResult,
} from "./server-requests.js";

/**
 * Default answers to the two server→client requests that need something only
 * the user can give: their model, and their own input.
 *
 * Both are wired from what a frontend already has — the confirm channel and the
 * ask-the-user channel — so no surface needs new UI to support them. Both are
 * also strictly opt-in: a frontend that passes neither leaves the capability
 * unadvertised, and servers never ask.
 */

/** The provider surface a sampling call needs (ChatProvider satisfies it). */
export type SamplingProvider = {
  chat(req: { messages: ChatMessage[]; signal?: AbortSignal; maxTokens?: number }): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
  }>;
  readonly model: string;
};

/** How much of the server's prompt to show in the approval prompt. */
const APPROVAL_PROMPT_CHARS = 800;

function summarizeForApproval(request: SamplingRequest): string {
  const conversation = request.messages.map((m) => `${m.role}: ${m.text}`).join("\n");
  const full = request.systemPrompt ? `system: ${request.systemPrompt}\n${conversation}` : conversation;
  return full.length > APPROVAL_PROMPT_CHARS ? `${full.slice(0, APPROVAL_PROMPT_CHARS)}\n…[truncated]` : full;
}

export type SamplingHandlerDeps = {
  /**
   * Resolved per request, not captured once: the provider usually only exists
   * after the agent's dependencies are built, which is after the MCP clients
   * have to be created. Returning undefined declines the request.
   */
  provider: () => SamplingProvider | undefined;
  /**
   * The frontend's confirm channel. A sampling call spends the user's tokens on
   * a prompt the user did not write, so it is confirmed EVERY time — there is
   * no approval-mode bypass here, only whatever the frontend's confirm does.
   */
  confirm: (request: PermissionRequest) => Promise<ConfirmResult>;
  /** Reports what the call cost. Defaults to a `[mcp:<server>]` line on stderr. */
  onUsage?: (usage: TokenUsage, request: SamplingRequest) => void;
};

function reportUsageToStderr(usage: TokenUsage, request: SamplingRequest): void {
  const total = usage.promptTokens + usage.completionTokens;
  const cost = usage.costUsd > 0 ? ` ($${usage.costUsd.toFixed(4)})` : "";
  process.stderr.write(`[mcp:${request.server}] sampling used ${total} tokens${cost}\n`);
}

/**
 * Run a server's sampling request against the user's own model, once the user
 * approves it.
 *
 * The server's prompt is shown verbatim (capped) in the approval, because that
 * text is the whole request: it was written by the server, not by the user or
 * the agent, and it is about to be paid for with the user's key.
 */
export function createMcpSamplingHandler(deps: SamplingHandlerDeps): SamplingHandler {
  const report = deps.onUsage ?? reportUsageToStderr;
  return async (request: SamplingRequest, signal?: AbortSignal): Promise<SamplingResult> => {
    const provider = deps.provider();
    if (!provider) {
      throw new McpError("mcp_sampling_unavailable", "no model is configured for this session");
    }
    const permissionRequest: PermissionRequest = {
      toolName: `mcp:${request.server}`,
      // Same tier as web_fetch and browser_navigate: an outward action with a
      // real-world cost, always shown to the user.
      permission: "env",
      description:
        `MCP server "${request.server}" is asking to run a model call on your account ` +
        `(${request.messages.length} message(s), model ${provider.model}):\n${summarizeForApproval(request)}`,
    };
    const answer = await deps.confirm(permissionRequest);
    const allowed = typeof answer === "boolean" ? answer : answer.allow;
    if (!allowed) {
      throw new McpError("mcp_sampling_denied", "the user declined this sampling request");
    }
    if (signal?.aborted) {
      throw new McpError("mcp_cancelled", "sampling request was cancelled");
    }

    const messages: ChatMessage[] = [
      ...(request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.text })),
    ];
    const response = await provider.chat({
      messages,
      ...(signal ? { signal } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    });
    if (response.usage) report(response.usage, request);
    return {
      text: response.content,
      model: provider.model,
      ...(response.finishReason !== undefined ? { stopReason: response.finishReason } : {}),
    };
  };
}

export type ElicitationHandlerDeps = {
  /**
   * The frontend's question channel — the same one the `ask_user` tool uses.
   * It offers a closed set of options, which is what bounds what elicitation
   * can collect here (see below).
   */
  askUser: (question: { question: string; options: string[] }) => Promise<string>;
};

const DECLINE = "Decline";

function describeField(field: ElicitationField): string {
  const label = field.title ?? field.name;
  const detail = field.description ? ` — ${field.description}` : "";
  return `${label}${field.required ? "" : " (optional)"}${detail}`;
}

/**
 * Ask the user for the values a server requested.
 *
 * Bounded on purpose: this answers through the frontend's option-picker, so it
 * can collect booleans and enums, and can confirm a request that asks for
 * nothing but agreement. A free-text field has no channel to be typed into, so
 * the request is DECLINED with that reason rather than answered with a guess —
 * a made-up value is worse than a decline, since the server will act on it.
 */
export function createMcpElicitationHandler(deps: ElicitationHandlerDeps): ElicitationHandler {
  return async (request: ElicitationRequest): Promise<ElicitationResult> => {
    const unanswerable = request.fields.filter(
      (field) => field.type !== "boolean" && (!field.options || field.options.length === 0),
    );
    if (unanswerable.length > 0) {
      throw new McpError(
        "mcp_elicitation_unsupported",
        `this client can only answer boolean or enum fields; ${unanswerable
          .map((field) => field.name)
          .join(", ")} need free-form input`,
      );
    }

    const content: Record<string, unknown> = {};
    for (const field of request.fields) {
      const options = field.type === "boolean" ? ["Yes", "No"] : [...(field.options ?? [])];
      const answer = await deps.askUser({
        question: `MCP server "${request.server}": ${request.message}\n${describeField(field)}`,
        options: [...options, DECLINE],
      });
      if (answer === DECLINE) return { action: "decline" };
      if (field.type === "boolean") {
        content[field.name] = answer === "Yes";
        continue;
      }
      if (field.type === "number" || field.type === "integer") {
        const value = Number(answer);
        if (!Number.isFinite(value)) return { action: "decline" };
        content[field.name] = field.type === "integer" ? Math.trunc(value) : value;
        continue;
      }
      content[field.name] = answer;
    }
    return { action: "accept", content };
  };
}
