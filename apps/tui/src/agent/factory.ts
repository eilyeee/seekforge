import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildAgentCoreDeps,
  createAgentCore,
  createDefaultDispatcher,
  createRuntimeClient,
  loadMcpToolSpecs,
  wrapProviderWithCache,
  type AgentCore,
  type AgentCoreDeps,
  type AgentDefinition,
  type BackgroundTasks,
  type DispatchManager,
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
  /** Run-bound controls for observing and steering dispatched subagents. */
  dispatchManager?: DispatchManager;
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

  // Shared skeleton (core buildAgentCoreDeps): retry bus + provider (thinking
  // controls travel with every provider it builds), the deepseek-reasoner
  // providerForModel fallback (silent here — only the CLI warns), and the
  // common config→deps conditional spread. TUI-only on top: the llm-cache wrap
  // of the MAIN provider (per-model providers stay uncached), the back-compat
  // routing.planModel fallback (flat key wins), and background/askUser wiring.
  const deps: AgentCoreDeps = {
    ...buildAgentCoreDeps(
      {
        provider: config.provider,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: opts.model ?? config.model,
        thinking: config.thinking,
        reasoningEffort: config.reasoningEffort,
        modelPricing: config.modelPricing,
        commandAllowlist: config.commandAllowlist,
        sandbox: config.sandbox,
        compaction: config.compaction,
        planModel: config.planModel ?? config.routing?.planModel,
        escalateOnFailure: config.escalateOnFailure,
        memoryAutoApproveConfidence: config.memoryAutoApproveConfidence,
        memoryMaintenance: config.memoryMaintenance,
        lintCommand: config.lintCommand,
        autoLint: config.autoLint,
        editFormat: config.editFormat,
      },
      // Opt-in disk cache for identical non-streaming calls (evals, subagents).
      config.llmCache
        ? {
            wrapProvider: (provider) => wrapProviderWithCache(provider, join(homedir(), ".seekforge", "llm-cache")),
          }
        : {},
    ),
    dispatcher: createDefaultDispatcher(opts.mcpToolSpecs ?? []),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    permissionRules: config.permissionRules,
    subagents: opts.subagents,
    ...(opts.dispatchManager ? { dispatchManager: opts.dispatchManager } : {}),
    hooks: config.hooks,
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
