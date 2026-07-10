/**
 * Shared AgentCoreDeps skeleton — the config→deps wiring that used to be
 * near-copied in four factories (apps/cli/src/agent-factory.ts,
 * apps/tui/src/agent/factory.ts, apps/server/src/agent.ts,
 * packages/eval-harness/src/agent-factory.ts) and drifted (the server once
 * missed editFormat; every new knob had to land 3-4 times).
 *
 * What buildAgentCoreDeps owns (identical across CLI/TUI/server):
 *   - one retry bus shared by every provider it builds (the active run routes
 *     retries into the agent event stream as provider.retry);
 *   - the main provider via createDeepSeekProvider(resolveProviderConfig(…))
 *     with the V4 thinking controls and optional fallbackModel/modelPricing;
 *   - the providerForModel closure (same key/endpoint, different model) with
 *     the deepseek-reasoner fallback — the reasoner cannot drive the
 *     tool-call loop, so it falls back to the main provider (the CLI hooks
 *     `onReasonerFallback` to print its warning; TUI/server stay silent);
 *   - the drift-prone conditional config→deps spread: sandbox (dropping
 *     "off") / compaction / planModel / escalateOnFailure /
 *     memoryAutoApproveConfidence / lintCommand (non-blank) / autoLint
 *     (explicit false only) / editFormat, plus the unconditional
 *     commandAllowlist passthrough.
 *
 * What stays in each app ON TOP of this skeleton (deliberate differences):
 *   - CLI: dispatcher(mcp specs), limits(maxTurns), confirm/onModelDelta/
 *     onReasoningDelta/askUser, extractMemory, runtime (with a stderr warning
 *     when runtimeBin is missing), permissionRules (opts override ?? config,
 *     key always present), subagents, hooks (key always present),
 *     fallbackModel input, the reasoner warning, and the CLI-only
 *     verifyCommand/autoVerify/finalizeReview/guardNoProgress knobs;
 *   - TUI: llmCache wrap of the MAIN provider (per-model providers stay
 *     unwrapped), background tasks, routing.planModel back-compat (resolved
 *     before calling in), silent runtime skip;
 *   - server: per-run frame overrides resolved before calling in,
 *     permissionRules/hooks only spread when configured (a contract test
 *     asserts the keys are ABSENT otherwise), plain dispatcher;
 *   - eval-harness: deliberately NOT on this skeleton — it runs without a
 *     retry bus (no provider.retry noise in eval event streams), builds
 *     providerForModel only when a planModel variant asks for it and without
 *     the reasoner fallback, and wires its knobs from AgentBuildOptions. It
 *     shares buildProvider below instead.
 */

import type { ChatProvider, ModelPricing, RetryInfo } from "../provider/index.js";
import { createDeepSeekProvider, resolveProviderConfig } from "../provider/index.js";
import { createRetryBus, type AgentCoreDeps, type RetryBus } from "./loop.js";

/**
 * Provider-construction inputs common to the main provider and the per-model
 * providers (everything except the model itself).
 */
export type ProviderBuildInput = {
  /** Provider preset name: "deepseek" (default) | "ark" | any preset. */
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  /** User-supplied per-model price table (cost tracking on preset-less providers). */
  modelPricing?: Record<string, ModelPricing>;
  /** DeepSeek V4 thinking mode; travels with every provider built. */
  thinking?: boolean;
  /** V4 reasoning effort; travels with every provider built. */
  reasoningEffort?: "high" | "max";
  /** Retry-progress callback (a retry bus's onRetry). */
  onRetry?: (info: RetryInfo) => void;
  /** Retry the request on this model when the primary is overloaded. */
  fallbackModel?: string;
};

/**
 * Builds one provider for `model` from the shared inputs — the exact
 * createDeepSeekProvider(resolveProviderConfig(…)) spread every factory used
 * to hand-copy. Also used directly by the eval harness, which keeps its own
 * (deliberately narrower) deps skeleton.
 */
export function buildProvider(input: ProviderBuildInput, model?: string): ChatProvider {
  return createDeepSeekProvider(
    resolveProviderConfig({
      provider: input.provider,
      apiKey: input.apiKey ?? "",
      baseUrl: input.baseUrl,
      model,
      ...(input.onRetry ? { onRetry: input.onRetry } : {}),
      ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
      ...(input.modelPricing ? { modelPricing: input.modelPricing } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    }),
  );
}

export type BuildAgentCoreDepsInput = Omit<ProviderBuildInput, "onRetry"> & {
  /** Main model (the caller has already resolved per-run overrides / flags). */
  model?: string;
  /** Extra command prefixes allowed to auto-run (passed through as-is). */
  commandAllowlist?: string[];
  /** OS-level command sandbox; "off" (or unset) adds no key. */
  sandbox?: "off" | "workspace-write" | "restricted";
  compaction?: "mechanical" | "llm";
  /** Already resolved by the caller (the TUI folds in routing.planModel). */
  planModel?: string;
  escalateOnFailure?: boolean;
  memoryAutoApproveConfidence?: number;
  /** Only a non-blank string adds the key. */
  lintCommand?: string;
  /** Only an explicit `false` adds the key (default-on knob). */
  autoLint?: boolean;
  editFormat?: "patch" | "whole";
};

export type BuildAgentCoreDepsExtras = {
  /**
   * Wraps the MAIN provider (TUI llm-cache). Per-model providers built by
   * providerForModel stay unwrapped — except the reasoner fallback, which
   * returns the (wrapped) main provider, matching the historical TUI wiring.
   */
  wrapProvider?: (provider: ChatProvider) => ChatProvider;
  /**
   * Fired when a per-agent "deepseek-reasoner" request falls back to the main
   * provider (the CLI prints a stderr warning; other frontends stay silent).
   */
  onReasonerFallback?: () => void;
};

/** The slice of AgentCoreDeps this factory owns; apps spread their deltas on top. */
export type AgentCoreDepsCommon = Pick<
  AgentCoreDeps,
  | "provider"
  | "commandAllowlist"
  | "sandbox"
  | "compaction"
  | "planModel"
  | "escalateOnFailure"
  | "memoryAutoApproveConfidence"
  | "lintCommand"
  | "autoLint"
  | "editFormat"
> & {
  retryBus: RetryBus & { onRetry: (info: RetryInfo) => void };
  providerForModel: (model: string) => ChatProvider;
};

/**
 * Builds the common AgentCoreDeps core (see the module header for the exact
 * split). The caller spreads the result and layers its app-specific deps
 * (dispatcher, confirm, runtime, permissionRules, hooks, …) on top.
 */
export function buildAgentCoreDeps(
  input: BuildAgentCoreDepsInput,
  extras: BuildAgentCoreDepsExtras = {},
): AgentCoreDepsCommon {
  // One retry bus shared by every provider this factory builds; the active
  // run routes its retries into the agent event stream (provider.retry).
  const retryBus = createRetryBus();
  const providerInput: ProviderBuildInput = { ...input, onRetry: retryBus.onRetry };
  const baseProvider = buildProvider(providerInput, input.model);
  const provider = extras.wrapProvider ? extras.wrapProvider(baseProvider) : baseProvider;

  return {
    provider,
    retryBus,
    // Per-agent model override (AgentDefinition.model / planModel): same
    // key/endpoint, different model. deepseek-reasoner cannot drive the
    // tool-call loop, so fall back to the main provider. NOTE: fallbackModel
    // belongs to the MAIN provider only and is stripped here.
    providerForModel: (model) => {
      if (model === "deepseek-reasoner") {
        extras.onReasonerFallback?.();
        return provider;
      }
      const { fallbackModel: _fallbackModel, ...perModelInput } = providerInput;
      return buildProvider(perModelInput, model);
    },
    commandAllowlist: input.commandAllowlist,
    ...(input.sandbox && input.sandbox !== "off" ? { sandbox: input.sandbox } : {}),
    ...(input.compaction ? { compaction: input.compaction } : {}),
    ...(input.planModel ? { planModel: input.planModel } : {}),
    ...(input.escalateOnFailure ? { escalateOnFailure: true } : {}),
    ...(input.memoryAutoApproveConfidence !== undefined
      ? { memoryAutoApproveConfidence: input.memoryAutoApproveConfidence }
      : {}),
    ...(typeof input.lintCommand === "string" && input.lintCommand.trim()
      ? { lintCommand: input.lintCommand }
      : {}),
    ...(input.autoLint === false ? { autoLint: false } : {}),
    ...(input.editFormat ? { editFormat: input.editFormat } : {}),
  };
}
