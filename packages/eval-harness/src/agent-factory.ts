/**
 * Default agent factory: assembles the real DeepSeek-backed AgentCore.
 * Injectable in tests via the CreateAgentFn contract (see task-runner.ts).
 *
 * Accepts an optional AgentBuildOptions so A/B variants can flip dep knobs
 * (e.g. compaction strategy) per run — see variants.ts.
 */

import { buildProvider, createAgentCore, createDefaultDispatcher, type AgentCoreDeps } from "@seekforge/core";
import type { EvalConfig } from "./config.js";
import type { CreateAgentFn } from "./task-runner.js";
import type { AgentBuildOptions } from "./variants.js";

export function createDefaultAgentFactory(config: EvalConfig, options: AgentBuildOptions = {}): CreateAgentFn {
  return () => {
    if (!config.apiKey) {
      throw new Error("no DeepSeek API key configured (env DEEPSEEK_API_KEY or .seekforge/config.json)");
    }
    // Provider construction shared with the app factories (core buildProvider).
    // The rest of the skeleton deliberately stays NARROWER than the apps' core
    // buildAgentCoreDeps: no retry bus (no provider.retry noise in recorded
    // eval event streams), no thinking controls, and providerForModel only
    // when a planModel variant asks for it — without the reasoner fallback.
    const providerInput = {
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
    };
    const deps: AgentCoreDeps = {
      // A variant may override the main model (e.g. model-pro); else config.
      provider: buildProvider(providerInput, options.model ?? config.model),
      dispatcher: createDefaultDispatcher(),
      // Deny anything that needs interactive approval: eval fixtures only
      // need allowlisted commands (npm test / node --test) and L1 writes,
      // which approvalMode "auto" already permits.
      confirm: async () => false,
      // Never pollute fixtures (or anything else) with extracted memory.
      extractMemory: false,
      ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
      ...(options.contextWindowTokens !== undefined ? { contextWindowTokens: options.contextWindowTokens } : {}),
      ...(options.escalateOnFailure ? { escalateOnFailure: true } : {}),
      ...(options.injectMemory === false ? { injectMemory: false } : {}),
      ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
      ...(options.autoVerify === false ? { autoVerify: false } : {}),
      ...(options.lintCommand ? { lintCommand: options.lintCommand } : {}),
      ...(options.autoLint === false ? { autoLint: false } : {}),
      ...(options.editFormat ? { editFormat: options.editFormat } : {}),
      ...(options.injectRelevantFiles === false ? { injectRelevantFiles: false } : {}),
      ...(options.finalizeReview ? { finalizeReview: true } : {}),
      ...(options.guardNoProgress ? { guardNoProgress: true } : {}),
      ...(options.planModel ? { planModel: options.planModel } : {}),
      // Same key/endpoint, different model — needed for plan/escalation.
      ...(options.planModel ? { providerForModel: (m: string) => buildProvider(providerInput, m) } : {}),
    };
    return { agent: createAgentCore(deps), deps };
  };
}
