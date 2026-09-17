import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildAgentCoreDeps,
  buildProvider,
  createAgentCore,
  createDefaultDispatcher,
  createRuntimeClient,
  loadPluginContributions,
  loadSkills,
  mergePluginHooks,
  mergePluginMcpServers,
  wrapProviderWithCache,
  type AgentCore,
  type AgentCoreDeps,
  type AgentDefinition,
  type ChatProvider,
  type BackgroundTasks,
  type DispatchManager,
  type McpClientEntry,
  type PluginContributions,
  type ProviderBuildInput,
  type RuntimeClient,
  type ToolSpec,
  type McpServerRequestHandlers,
  type UsageBus,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest, PermissionRule } from "@seekforge/shared";
import type { TuiConfig } from "../config.js";
import { createMcpRegistry, type McpRegistry } from "./mcp-registry.js";

export type TuiAgentOptions = {
  config: TuiConfig;
  /** Workspace used to resolve first-class plugin contributions. Defaults to cwd. */
  workspace?: string;
  model?: string;
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  /** Writes a `remember: "always"` approval to the user config. */
  persistRule?: (rule: PermissionRule) => Promise<void> | void;
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (V4 thinking mode). */
  onReasoningDelta?: (chunk: string) => void;
  extractMemory: boolean;
  /** Specialist agents the loop may dispatch via dispatch_agent. */
  subagents?: AgentDefinition[];
  /** Extra tools from MCP servers (see prepareMcp). */
  mcpToolSpecs?: ToolSpec[];
  /** Request-local plugin snapshot shared by skills, agents, hooks, and MCP. */
  pluginContributions?: PluginContributions;
  /** Shared background-task manager: tasks survive across turns (app owns it). */
  background?: BackgroundTasks;
  /** ask_user channel (TUI question overlay). */
  askUser?: (q: { question: string; options: string[]; freeText?: boolean }) => Promise<string>;
  /** Run-bound controls for observing and steering dispatched subagents. */
  dispatchManager?: DispatchManager;
  /** Session usage bus: tokens an MCP server spent through sampling. */
  usageBus?: UsageBus;
  /** Exact tool gate for this run (a custom command's `allowed-tools`). */
  allowedTools?: string[];
  /**
   * Fired once when no price is known for the model, so cost reports 0 for
   * every request. The TUI shows a running cost and a `costBudgetUsd` warning
   * threshold, both of which are meaningless then; absent, nothing is said.
   */
  onPricingUnavailable?: (info: { provider?: string; model: string }) => void;
};

export type TuiAgent = {
  agent: AgentCore;
  dispose: () => void;
};

/**
 * The provider-construction inputs for this config — the single mapping every
 * TUI provider goes through, so a one-off model call (focused /compact, memory
 * keywords, MCP sampling) talks to the same preset, endpoint and key as a run.
 */
export function tuiProviderInput(config: TuiConfig): ProviderBuildInput {
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    modelPricing: config.modelPricing,
    inlineImages: config.inlineImages,
  };
}

/** A provider for `model` (default: the configured one) built like a run's main provider. */
export function buildTuiProvider(config: TuiConfig, model?: string): ChatProvider {
  return buildProvider(tuiProviderInput(config), model ?? config.model);
}

/**
 * Builds the AgentCoreDeps from TUI config (the config -> deps mapping), kept
 * separate from createTuiAgent so the passthrough is unit-testable — mirrors the
 * CLI's createCliAgentDeps. dispose() releases the runtime.
 */
export function buildTuiDeps(opts: TuiAgentOptions): { deps: AgentCoreDeps; dispose: () => void } {
  const { config } = opts;
  const workspace = opts.workspace ?? process.cwd();
  const pluginContributions = opts.pluginContributions ?? loadPluginContributions(workspace);

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin) {
    if (existsSync(config.runtimeBin)) {
      runtime = createRuntimeClient({ binPath: config.runtimeBin });
    } else {
      // No console noise in the TUI; the Rust backend is optional.
      runtime = undefined;
    }
  }

  // Shared skeleton (core buildAgentCoreDeps): retry bus + provider (thinking
  // controls travel with every provider it builds), the deepseek-reasoner
  // providerForModel fallback (silent here — only the CLI warns), and the
  // common config→deps conditional spread. TUI-only on top: the llm-cache wrap
  // of the MAIN provider (per-model providers stay uncached), the back-compat
  // routing.planModel fallback (flat key wins), and background/askUser wiring.
  const deps: AgentCoreDeps = {
    ...buildAgentCoreDeps(
      {
        ...tuiProviderInput(config),
        model: opts.model ?? config.model,
        commandAllowlist: config.commandAllowlist,
        sandbox: config.sandbox,
        compaction: config.compaction,
        planModel: config.planModel ?? config.routing?.planModel,
        escalateOnFailure: config.escalateOnFailure,
        memoryAutoApproveConfidence: config.memoryAutoApproveConfidence,
        lintCommand: config.lintCommand,
        autoLint: config.autoLint,
        editFormat: config.editFormat,
      },
      {
        // Opt-in disk cache for identical non-streaming calls (evals, subagents).
        ...(config.llmCache
          ? {
              wrapProvider: (provider: ChatProvider) =>
                wrapProviderWithCache(provider, join(homedir(), ".seekforge", "llm-cache")),
            }
          : {}),
        ...(opts.onPricingUnavailable ? { onPricingUnavailable: opts.onPricingUnavailable } : {}),
      },
    ),
    dispatcher: createDefaultDispatcher(opts.mcpToolSpecs ?? []),
    confirm: opts.confirm,
    ...(opts.persistRule ? { persistRule: opts.persistRule } : {}),
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    permissionRules: config.permissionRules,
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    subagents: opts.subagents,
    ...(opts.dispatchManager ? { dispatchManager: opts.dispatchManager } : {}),
    ...(opts.usageBus ? { usageBus: opts.usageBus } : {}),
    hooks: mergePluginHooks(workspace, config.hooks, pluginContributions),
    pluginContributions,
    skillSnapshot: loadSkills(workspace, pluginContributions),
    ...(opts.background ? { background: opts.background } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
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
 * Spawns the configured MCP servers (config + enabled plugins), tracked per
 * server by the returned registry (see mcp-registry.ts). Callers must invoke
 * dispose() when the session ends. `workspacePath` (absolute) is advertised to
 * each server via the roots capability, so servers answer roots/list with the
 * real workspace.
 */
export async function prepareMcp(
  config: TuiConfig,
  workspacePath?: string,
  serverRequestHandlers?: McpServerRequestHandlers,
  opts: { origins?: Record<string, "user" | "repository">; quiet?: () => boolean } = {},
): Promise<{
  registry: McpRegistry;
  specs: ToolSpec[];
  entries: McpClientEntry[];
  pluginContributions: PluginContributions;
  dispose: () => void;
}> {
  const workspace = workspacePath ?? process.cwd();
  const pluginContributions = loadPluginContributions(workspace);
  const servers = mergePluginMcpServers(workspace, config.mcpServers, pluginContributions);
  const registry = await createMcpRegistry({
    servers,
    // A configured name with no recorded origin survived the merge as the
    // user's own; names only a plugin contributes stay "plugin".
    origins:
      opts.origins ?? Object.fromEntries(Object.keys(config.mcpServers ?? {}).map((name) => [name, "user" as const])),
    ...(workspacePath ? { roots: [workspacePath] } : {}),
    ...(serverRequestHandlers ? { handlers: serverRequestHandlers } : {}),
    ...(opts.quiet ? { quiet: opts.quiet } : {}),
  });
  return {
    registry,
    specs: registry.specs(),
    entries: registry.entries(),
    pluginContributions,
    dispose: () => registry.dispose(),
  };
}
