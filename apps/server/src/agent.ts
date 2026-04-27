/**
 * Agent assembly for WS-driven runs.
 *
 * The default factory mirrors apps/cli/src/agent-factory.ts (provider from
 * config, default dispatcher, runtime when configured, commandAllowlist from
 * config). Tests inject a fake factory via startServer({createAgent}).
 */

import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRuntimeClient,
  type AgentCore,
  type RuntimeClient,
} from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import { loadConfig } from "./config.js";

export type CreateAgentOptions = {
  workspace: string;
  /** Permission bridge: resolves with the user's decision over the WS. */
  confirm: (req: PermissionRequest) => Promise<boolean>;
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (thinking mode), mirrored over the WS. */
  onReasoningDelta?: (chunk: string) => void;
  /** ask_user bridge: resolves with the user's answer over the WS. */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
  extractMemory: boolean;
};

export type AgentHandle = {
  agent: AgentCore;
  dispose: () => void;
};

export type CreateAgentFn = (opts: CreateAgentOptions) => AgentHandle;

export const createDefaultAgent: CreateAgentFn = (opts) => {
  const config = loadConfig(opts.workspace);

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin && existsSync(config.runtimeBin)) {
    runtime = createRuntimeClient({ binPath: config.runtimeBin });
  }

  const agent = createAgentCore({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey ?? "",
      baseUrl: config.baseUrl,
      model: config.model,
      // Thinking mode + effort passthrough (mirrors apps/tui agent factory).
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    ...(config.sandbox && config.sandbox !== "off" ? { sandbox: config.sandbox } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
  });

  return { agent, dispose: () => runtime?.dispose() };
};
