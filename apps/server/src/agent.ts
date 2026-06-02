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
  createRetryBus,
  createRuntimeClient,
  type AgentCore,
  type RuntimeClient,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { loadConfig } from "./config.js";

/** Per-run model overrides from a start/send frame (win over config). */
export type RunOverrides = {
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
};

export type CreateAgentOptions = {
  workspace: string;
  /**
   * Permission bridge: resolves with the user's decision over the WS. May
   * return the richer ConfirmResult ({ allow, remember: "session" }) so core
   * grows its session allowlist on "allow for session".
   */
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  onModelDelta?: (chunk: string) => void;
  /** Streamed chain-of-thought deltas (thinking mode), mirrored over the WS. */
  onReasoningDelta?: (chunk: string) => void;
  /** ask_user bridge: resolves with the user's answer over the WS. */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
  extractMemory: boolean;
  /** Per-run model/thinking overrides (frame fields win over config). */
  overrides?: RunOverrides;
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

  // Per-run frame overrides win over config (a fresh agent is assembled per run).
  const model = opts.overrides?.model ?? config.model;
  const thinking = opts.overrides?.thinking ?? config.thinking;
  const reasoningEffort = opts.overrides?.reasoningEffort ?? config.reasoningEffort;

  // Retry bus: routes provider retries into this run's provider.retry events,
  // forwarded to the client over the WS by the generic event forwarder.
  const retryBus = createRetryBus();
  const thinkingOpts = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  const provider = createDeepSeekProvider({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
    model,
    onRetry: retryBus.onRetry,
    ...thinkingOpts,
  });
  const agent = createAgentCore({
    provider,
    retryBus,
    // Same key/endpoint, different model — used for plan runs + failure
    // escalation (mirrors the CLI agent factory). deepseek-reasoner cannot
    // drive the tool-call loop, so fall back to the default model for it.
    providerForModel: (m) => {
      if (m === "deepseek-reasoner") return provider;
      return createDeepSeekProvider({
        apiKey: config.apiKey ?? "",
        baseUrl: config.baseUrl,
        model: m,
        onRetry: retryBus.onRetry,
        ...thinkingOpts,
      });
    },
    dispatcher: createDefaultDispatcher(),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    commandAllowlist: config.commandAllowlist,
    ...(config.permissionRules ? { permissionRules: config.permissionRules } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(config.sandbox && config.sandbox !== "off" ? { sandbox: config.sandbox } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
    ...(config.planModel ? { planModel: config.planModel } : {}),
    ...(config.escalateOnFailure ? { escalateOnFailure: true } : {}),
    ...(config.memoryAutoApproveConfidence !== undefined
      ? { memoryAutoApproveConfidence: config.memoryAutoApproveConfidence }
      : {}),
  });

  return { agent, dispose: () => runtime?.dispose() };
};
