import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRuntimeClient,
  loadMcpToolSpecs,
  type AgentCore,
  type AgentDefinition,
  type RuntimeClient,
  type ToolSpec,
} from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import type { CliConfig } from "./config.js";

export type CliAgentOptions = {
  config: CliConfig;
  model?: string;
  confirm: (req: PermissionRequest) => Promise<boolean>;
  onModelDelta?: (chunk: string) => void;
  extractMemory: boolean;
  /** Specialist agents the loop may dispatch via dispatch_agent. */
  subagents?: AgentDefinition[];
  /** Extra tools from MCP servers (see prepareMcp). */
  mcpToolSpecs?: ToolSpec[];
};

export type CliAgent = {
  agent: AgentCore;
  dispose: () => void;
};

/** Assembles AgentCore from CLI config; shared by run/ask/repl/serve paths. */
export function createCliAgent(opts: CliAgentOptions): CliAgent {
  const { config } = opts;

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin) {
    if (existsSync(config.runtimeBin)) {
      runtime = createRuntimeClient({ binPath: config.runtimeBin });
    } else {
      console.error(`warning: runtimeBin not found (${config.runtimeBin}); using the TypeScript backend`);
    }
  }

  const provider = createDeepSeekProvider({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
    model: opts.model ?? config.model,
  });

  const agent = createAgentCore({
    provider,
    // Per-agent model override (AgentDefinition.model): same key/endpoint,
    // different model. deepseek-reasoner cannot drive the tool-call loop.
    providerForModel: (model) => {
      if (model === "deepseek-reasoner") {
        console.error(
          'warning: subagent model "deepseek-reasoner" does not support tool calls; using the default model',
        );
        return provider;
      }
      return createDeepSeekProvider({ apiKey: config.apiKey ?? "", baseUrl: config.baseUrl, model });
    },
    dispatcher: createDefaultDispatcher(opts.mcpToolSpecs ?? []),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    subagents: opts.subagents,
  });

  return { agent, dispose: () => runtime?.dispose() };
}

/**
 * Spawns the configured MCP servers and builds their ToolSpecs for
 * createCliAgent. Callers must invoke dispose() when the session ends
 * (kills the server child processes). No servers configured -> no-op.
 */
export async function prepareMcp(config: CliConfig): Promise<{ specs: ToolSpec[]; dispose: () => void }> {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return { specs: [], dispose: () => {} };
  }
  return loadMcpToolSpecs(config.mcpServers);
}
