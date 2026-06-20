import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRetryBus,
  createRuntimeClient,
  loadMcpToolSpecs,
  type AgentCore,
  type AgentCoreDeps,
  type AgentDefinition,
  type RuntimeClient,
  type ToolSpec,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest, PermissionRule } from "@seekforge/shared";
import type { CliConfig } from "./config.js";

export type CliAgentOptions = {
  config: CliConfig;
  model?: string;
  /** Model to retry the request with if the primary is overloaded (CLI --fallback-model). */
  fallbackModel?: string;
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (V4 thinking mode). */
  onReasoningDelta?: (chunk: string) => void;
  /** ask_user channel (REPL readline prompt). Absent in non-interactive runs. */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
  extractMemory: boolean;
  /** Specialist agents the loop may dispatch via dispatch_agent. */
  subagents?: AgentDefinition[];
  /** Extra tools from MCP servers (see prepareMcp). */
  mcpToolSpecs?: ToolSpec[];
  /** Cap on agent turns (maps to limits.maxAgentTurns); CLI --max-turns. */
  maxTurns?: number;
  /**
   * Per-run permission rules (CLI --allowedTools/--disallowedTools), prepended
   * to config rules. When set, replaces config.permissionRules for this run
   * (the caller is expected to have already merged the base in).
   */
  permissionRules?: PermissionRule[];
};

export type CliAgent = {
  agent: AgentCore;
  dispose: () => void;
};

export type CliAgentDeps = {
  deps: AgentCoreDeps;
  dispose: () => void;
};

/**
 * Builds the AgentCoreDeps from CLI config — the same wiring (provider,
 * dispatcher, confirm, runtime, allowlist, permission rules, hooks, sandbox,
 * planModel/escalation, …) that createAgentCore would receive. Callers that
 * need the deps object directly (e.g. `seekforge loop` → runAutoLoop) use this;
 * createCliAgent layers createAgentCore on top. dispose() releases the runtime.
 */
export function createCliAgentDeps(opts: CliAgentOptions): CliAgentDeps {
  const { config } = opts;

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin) {
    if (existsSync(config.runtimeBin)) {
      runtime = createRuntimeClient({ binPath: config.runtimeBin });
    } else {
      console.error(`warning: runtimeBin not found (${config.runtimeBin}); using the TypeScript backend`);
    }
  }

  // V4 thinking controls travel with every provider we build (main + per-agent).
  const thinkingOpts = {
    ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
  // One retry bus shared by every provider this factory builds; the active
  // run routes its retries into the agent event stream (provider.retry).
  const retryBus = createRetryBus();
  const provider = createDeepSeekProvider({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
    model: opts.model ?? config.model,
    onRetry: retryBus.onRetry,
    ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
    ...thinkingOpts,
  });

  const deps: AgentCoreDeps = {
    provider,
    retryBus,
    // Per-agent model override (AgentDefinition.model): same key/endpoint,
    // different model. deepseek-reasoner cannot drive the tool-call loop.
    providerForModel: (model) => {
      if (model === "deepseek-reasoner") {
        console.error(
          'warning: subagent model "deepseek-reasoner" does not support tool calls; using the default model',
        );
        return provider;
      }
      return createDeepSeekProvider({
        apiKey: config.apiKey ?? "",
        baseUrl: config.baseUrl,
        model,
        onRetry: retryBus.onRetry,
        ...thinkingOpts,
      });
    },
    dispatcher: createDefaultDispatcher(opts.mcpToolSpecs ?? []),
    ...(opts.maxTurns !== undefined && opts.maxTurns > 0 ? { limits: { maxAgentTurns: opts.maxTurns } } : {}),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    permissionRules: opts.permissionRules ?? config.permissionRules,
    subagents: opts.subagents,
    hooks: config.hooks,
    ...(config.sandbox && config.sandbox !== "off" ? { sandbox: config.sandbox } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
    ...(config.planModel ? { planModel: config.planModel } : {}),
    ...(config.escalateOnFailure ? { escalateOnFailure: true } : {}),
    ...(typeof config.verifyCommand === "string" && config.verifyCommand.trim()
      ? { verifyCommand: config.verifyCommand }
      : {}),
    ...(config.finalizeReview ? { finalizeReview: true } : {}),
    ...(config.memoryAutoApproveConfidence !== undefined
      ? { memoryAutoApproveConfidence: config.memoryAutoApproveConfidence }
      : {}),
  };

  return { deps, dispose: () => runtime?.dispose() };
}

/** Assembles AgentCore from CLI config; shared by run/ask/repl/serve paths. */
export function createCliAgent(opts: CliAgentOptions): CliAgent {
  const { deps, dispose } = createCliAgentDeps(opts);
  return { agent: createAgentCore(deps), dispose };
}

/**
 * Spawns the configured MCP servers and builds their ToolSpecs for
 * createCliAgent. Callers must invoke dispose() when the session ends
 * (kills the server child processes). No servers configured -> no-op.
 * `workspacePath` (absolute) is advertised to each server via the roots
 * capability, so servers answer roots/list with the real workspace.
 */
export async function prepareMcp(
  config: CliConfig,
  workspacePath?: string,
): Promise<{ specs: ToolSpec[]; dispose: () => void }> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return { specs: [], dispose: () => {} };
  }
  return loadMcpToolSpecs(config.mcpServers, workspacePath ? [workspacePath] : undefined);
}
