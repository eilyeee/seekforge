/**
 * Agent assembly for WS-driven runs.
 *
 * The default factory mirrors apps/cli/src/agent-factory.ts (provider from
 * config, default dispatcher, runtime when configured, commandAllowlist from
 * config). Tests inject a fake factory via startServer({createAgent}).
 */

import { existsSync } from "node:fs";
import {
  buildAgentCoreDeps,
  createAgentCore,
  createDefaultDispatcher,
  createRuntimeClient,
  runAutoLoop,
  resumeAutoLoop,
  type AgentCore,
  type AgentCoreDeps,
  type LoopOptions,
  type LoopResult,
  type RuntimeClient,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { loadConfig } from "./config.js";

/** Per-run model overrides from a start/send frame (win over config). */
export type RunOverrides = {
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
  /** Output style name (built-in or custom), resolved to appendSystemPrompt. */
  outputStyle?: string;
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

/**
 * Runs the core auto-loop for a connection-scoped agent assembly. The same
 * confirm/askUser/onModelDelta plumbing as a normal run is reused, so the
 * loop's inner runs emit permission.request/question.request/event frames.
 */
export type RunLoopFn = (opts: CreateAgentOptions, loopOpts: LoopOptions) => Promise<LoopResult>;
export type ResumeLoopFn = (
  opts: CreateAgentOptions,
  loopId: string,
  loopOpts: Parameters<typeof resumeAutoLoop>[2],
) => Promise<LoopResult>;

/**
 * Assembles the connection-scoped AgentCoreDeps from a config + the WS-tied
 * confirm/askUser/onModelDelta bridges. Shared by createDefaultAgent (which
 * feeds it to createAgentCore) and runDefaultLoop (which feeds it to
 * runAutoLoop) so a loop's inner runs use the exact same plumbing as a run.
 */
export function buildAgentDeps(opts: CreateAgentOptions): AgentCoreDeps & { runtime?: RuntimeClient } {
  const config = loadConfig(opts.workspace);

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin && existsSync(config.runtimeBin)) {
    runtime = createRuntimeClient({ binPath: config.runtimeBin });
  }

  // Per-run frame overrides win over config (a fresh agent is assembled per run).
  const model = opts.overrides?.model ?? config.model;
  const thinking = opts.overrides?.thinking ?? config.thinking;
  const reasoningEffort = opts.overrides?.reasoningEffort ?? config.reasoningEffort;

  // Shared skeleton (core buildAgentCoreDeps): retry bus (routes provider
  // retries into this run's provider.retry events, forwarded to the client
  // over the WS by the generic event forwarder) + provider with the resolved
  // per-run thinking controls, the deepseek-reasoner providerForModel
  // fallback (silent here — only the CLI warns), and the common config→deps
  // conditional spread. Server-only on top: the WS confirm/askUser/
  // onModelDelta bridges, and permissionRules/hooks spread ONLY when
  // configured (a contract test asserts the keys are absent otherwise).
  return {
    ...buildAgentCoreDeps({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model,
      thinking,
      reasoningEffort,
      modelPricing: config.modelPricing,
      commandAllowlist: config.commandAllowlist,
      sandbox: config.sandbox,
      compaction: config.compaction,
      planModel: config.planModel,
      escalateOnFailure: config.escalateOnFailure,
      memoryAutoApproveConfidence: config.memoryAutoApproveConfidence,
      lintCommand: config.lintCommand,
      autoLint: config.autoLint,
      editFormat: config.editFormat,
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    extractMemory: opts.extractMemory,
    runtime,
    ...(config.permissionRules ? { permissionRules: config.permissionRules } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
  };
}

export const createDefaultAgent: CreateAgentFn = (opts) => {
  const deps = buildAgentDeps(opts);
  const agent = createAgentCore(deps);
  return { agent, dispose: () => deps.runtime?.dispose() };
};

/**
 * Drives the core auto-loop for one task using the connection-scoped deps.
 * The loop internally builds the agent via createAgentCore(deps), so its
 * runs share this socket's confirm/askUser/onModelDelta bridges.
 */
export const runDefaultLoop: RunLoopFn = (opts, loopOpts) => {
  const deps = buildAgentDeps(opts);
  return runAutoLoop(deps, loopOpts).finally(() => deps.runtime?.dispose());
};

export const resumeDefaultLoop: ResumeLoopFn = (opts, loopId, loopOpts) => {
  const deps = buildAgentDeps(opts);
  return resumeAutoLoop(deps, loopId, loopOpts).finally(() => deps.runtime?.dispose());
};
