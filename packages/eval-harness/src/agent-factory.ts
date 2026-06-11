/**
 * Default agent factory: assembles the real DeepSeek-backed AgentCore.
 * Injectable in tests via the CreateAgentFn contract (see task-runner.ts).
 */

import { createAgentCore, createDeepSeekProvider, createDefaultDispatcher } from "@seekforge/core";
import type { EvalConfig } from "./config.js";
import type { CreateAgentFn } from "./task-runner.js";

export function createDefaultAgentFactory(config: EvalConfig): CreateAgentFn {
  return () => {
    if (!config.apiKey) {
      throw new Error("no DeepSeek API key configured (env DEEPSEEK_API_KEY or .seekforge/config.json)");
    }
    const agent = createAgentCore({
      provider: createDeepSeekProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      }),
      dispatcher: createDefaultDispatcher(),
      // Deny anything that needs interactive approval: eval fixtures only
      // need allowlisted commands (npm test / node --test) and L1 writes,
      // which approvalMode "auto" already permits.
      confirm: async () => false,
      // Never pollute fixtures (or anything else) with extracted memory.
      extractMemory: false,
    });
    return { agent };
  };
}
