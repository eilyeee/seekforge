import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRuntimeClient,
  type AgentCore,
  type AgentDefinition,
  type RuntimeClient,
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

  const agent = createAgentCore({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey ?? "",
      baseUrl: config.baseUrl,
      model: opts.model ?? config.model,
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    subagents: opts.subagents,
  });

  return { agent, dispose: () => runtime?.dispose() };
}
