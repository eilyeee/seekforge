import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRetryBus,
  createRuntimeClient,
  loadMcpToolSpecs,
  resolveProviderConfig,
  wrapProviderWithCache,
  type AgentCore,
  type AgentCoreDeps,
  type AgentDefinition,
  type BackgroundTasks,
  type McpClientEntry,
  type RuntimeClient,
  type ToolSpec,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "../config.js";

export type TuiAgentOptions = {
  config: TuiConfig;
  model?: string;
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (V4 thinking mode). */
  onReasoningDelta?: (chunk: string) => void;
  extractMemory: boolean;
  /** Specialist agents the loop may dispatch via dispatch_agent. */
  subagents?: AgentDefinition[];
  /** Extra tools from MCP servers (see prepareMcp). */
  mcpToolSpecs?: ToolSpec[];
  /** Shared background-task manager: tasks survive across turns (app owns it). */
  background?: BackgroundTasks;
  /** ask_user channel (TUI question overlay). */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
};

export type TuiAgent = {
  agent: AgentCore;
  dispose: () => void;
};

/**
 * Builds the AgentCoreDeps from TUI config (the config -> deps mapping), kept
 * separate from createTuiAgent so the passthrough is unit-testable — mirrors the
 * CLI's createCliAgentDeps. dispose() releases the runtime.
 */
export function buildTuiDeps(opts: TuiAgentOptions): { deps: AgentCoreDeps; dispose: () => void } {
  const { config } = opts;

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin) {
    if (existsSync(config.runtimeBin)) {
      runtime = createRuntimeClient({ binPath: config.runtimeBin });
    } else {
      // No console noise in the TUI; the Rust backend is optional.
      runtime = undefined;
    }
  }

  const thinkingOpts = {
    ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
  // One retry bus shared by every provider; the active run routes provider
  // retries into its event stream (provider.retry).
  const retryBus = createRetryBus();
  const baseProvider = createDeepSeekProvider(
    resolveProviderConfig({
      provider: config.provider,
      apiKey: config.apiKey ?? "",
      baseUrl: config.baseUrl,
      model: opts.model ?? config.model,
      onRetry: retryBus.onRetry,
      ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
      ...thinkingOpts,
    }),
  );
  // Opt-in disk cache for identical non-streaming calls (evals, subagents).
  const provider = config.llmCache
    ? wrapProviderWithCache(baseProvider, join(homedir(), ".seekforge", "llm-cache"))
    : baseProvider;

  const deps: AgentCoreDeps = {
    provider,
    retryBus,
    // Per-agent model override: same key/endpoint, different model.
    // deepseek-reasoner cannot drive the tool-call loop, so fall back.
    providerForModel: (model) => {
      if (model === "deepseek-reasoner") return provider;
      return createDeepSeekProvider(
        resolveProviderConfig({
          provider: config.provider,
          apiKey: config.apiKey ?? "",
          baseUrl: config.baseUrl,
          model,
          onRetry: retryBus.onRetry,
          ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
          ...thinkingOpts,
        }),
      );
    },
    dispatcher: createDefaultDispatcher(opts.mcpToolSpecs ?? []),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    permissionRules: config.permissionRules,
    subagents: opts.subagents,
    hooks: config.hooks,
    ...(opts.background ? { background: opts.background } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    ...(config.sandbox && config.sandbox !== "off" ? { sandbox: config.sandbox } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
    ...((config.planModel ?? config.routing?.planModel)
      ? { planModel: config.planModel ?? config.routing?.planModel }
      : {}),
    ...(config.escalateOnFailure ? { escalateOnFailure: true } : {}),
    ...(config.memoryAutoApproveConfidence !== undefined
      ? { memoryAutoApproveConfidence: config.memoryAutoApproveConfidence }
      : {}),
  };

  return { deps, dispose: () => runtime?.dispose() };
}

/**
 * Assembles an in-process AgentCore from TUI config. Mirrors the CLI's
 * createCliAgent (apps/cli/src/agent-factory.ts) without depending on it.
 */
export function createTuiAgent(opts: TuiAgentOptions): TuiAgent {
  const { deps, dispose } = buildTuiDeps(opts);
  return { agent: createAgentCore(deps), dispose };
}

/**
 * Spawns the configured MCP servers and builds their ToolSpecs. Callers must
 * invoke dispose() when the session ends. No servers configured -> no-op.
 * `workspacePath` (absolute) is advertised to each server via the roots
 * capability, so servers answer roots/list with the real workspace.
 */
export async function prepareMcp(
  config: TuiConfig,
  workspacePath?: string,
): Promise<{ specs: ToolSpec[]; entries: McpClientEntry[]; dispose: () => void }> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return { specs: [], entries: [], dispose: () => {} };
  }
  return loadMcpToolSpecs(config.mcpServers, workspacePath ? [workspacePath] : undefined);
}
