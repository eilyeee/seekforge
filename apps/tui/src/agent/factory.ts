import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRuntimeClient,
  loadMcpToolSpecs,
  type AgentCore,
  type AgentDefinition,
  type BackgroundTasks,
  type McpClientEntry,
  type RuntimeClient,
  type ToolSpec,
} from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "../config.js";

export type TuiAgentOptions = {
  config: TuiConfig;
  model?: string;
  confirm: (req: PermissionRequest) => Promise<boolean>;
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
 * Assembles an in-process AgentCore from TUI config. Mirrors the CLI's
 * createCliAgent (apps/cli/src/agent-factory.ts) without depending on it.
 */
export function createTuiAgent(opts: TuiAgentOptions): TuiAgent {
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
  const provider = createDeepSeekProvider({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
    model: opts.model ?? config.model,
    ...thinkingOpts,
  });

  const agent = createAgentCore({
    provider,
    // Per-agent model override: same key/endpoint, different model.
    // deepseek-reasoner cannot drive the tool-call loop, so fall back.
    providerForModel: (model) => {
      if (model === "deepseek-reasoner") return provider;
      return createDeepSeekProvider({ apiKey: config.apiKey ?? "", baseUrl: config.baseUrl, model, ...thinkingOpts });
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
  });

  return { agent, dispose: () => runtime?.dispose() };
}

/**
 * Spawns the configured MCP servers and builds their ToolSpecs. Callers must
 * invoke dispose() when the session ends. No servers configured -> no-op.
 */
export async function prepareMcp(
  config: TuiConfig,
): Promise<{ specs: ToolSpec[]; entries: McpClientEntry[]; dispose: () => void }> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return { specs: [], entries: [], dispose: () => {} };
  }
  return loadMcpToolSpecs(config.mcpServers);
}
