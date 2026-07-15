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
  loadAgentDefinitions,
  loadMcpToolSpecs,
  readMcpResource,
  runAutoLoop,
  resumeAutoLoop,
  type AgentCore,
  type AgentCoreDeps,
  type LoopOptions,
  type LoopResult,
  type RuntimeClient,
  type DispatchManager,
  type ToolSpec,
  type McpClientEntry,
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
  /** Run-local sandbox override (frame wins over project config). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
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
  /** Run-bound subagent controls owned by the current WS connection. */
  dispatchManager?: DispatchManager;
};

export type AgentHandle = {
  agent: AgentCore;
  /** Resolves inline @mcp:<server>:<uri> references using this run's clients. */
  expandTask?: (task: string, signal?: AbortSignal) => Promise<string>;
  dispose: () => void;
};

export type CreateAgentFn = (opts: CreateAgentOptions) => AgentHandle | Promise<AgentHandle>;

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
export function buildAgentDeps(
  opts: CreateAgentOptions,
  mcpToolSpecs: ToolSpec[] = [],
): AgentCoreDeps & { runtime?: RuntimeClient } {
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
      sandbox: opts.overrides?.sandbox ?? config.sandbox,
      compaction: config.compaction,
      planModel: config.planModel,
      escalateOnFailure: config.escalateOnFailure,
      memoryAutoApproveConfidence: config.memoryAutoApproveConfidence,
      lintCommand: config.lintCommand,
      autoLint: config.autoLint,
      editFormat: config.editFormat,
    }),
    dispatcher: createDefaultDispatcher(mcpToolSpecs),
    confirm: opts.confirm,
    onModelDelta: opts.onModelDelta,
    ...(opts.onReasoningDelta ? { onReasoningDelta: opts.onReasoningDelta } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    extractMemory: opts.extractMemory,
    subagents: loadAgentDefinitions(opts.workspace),
    ...(opts.dispatchManager ? { dispatchManager: opts.dispatchManager } : {}),
    runtime,
    ...(config.permissionRules ? { permissionRules: config.permissionRules } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
  };
}

async function prepareAgentDeps(opts: CreateAgentOptions): Promise<{
  deps: AgentCoreDeps & { runtime?: RuntimeClient };
  entries: McpClientEntry[];
  disposeMcp: () => void;
}> {
  const servers = loadConfig(opts.workspace).mcpServers ?? {};
  const mcp = await loadMcpToolSpecs(servers, [opts.workspace]);
  return { deps: buildAgentDeps(opts, mcp.specs), entries: mcp.entries, disposeMcp: mcp.dispose };
}

async function expandMcpResources(task: string, entries: McpClientEntry[], signal?: AbortSignal): Promise<string> {
  const refs = [...task.matchAll(/@mcp:([A-Za-z0-9_-]+):(\S+)/g)].slice(0, 5);
  if (refs.length === 0) return task;
  const blocks: string[] = [];
  for (const match of refs) {
    const server = match[1]!;
    const uri = match[2]!;
    try {
      blocks.push(`[MCP resource ${server}:${uri}]\n${await readMcpResource(server, uri, entries, signal)}`);
    } catch (err) {
      blocks.push(`[MCP resource ${server}:${uri} unavailable: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }
  return `${task}\n\n${blocks.join("\n\n")}`;
}

export const createDefaultAgent: CreateAgentFn = async (opts) => {
  const { deps, entries, disposeMcp } = await prepareAgentDeps(opts);
  const agent = createAgentCore(deps);
  return {
    agent,
    expandTask: (task, signal) => expandMcpResources(task, entries, signal),
    dispose: () => { deps.runtime?.dispose(); disposeMcp(); },
  };
};

/**
 * Drives the core auto-loop for one task using the connection-scoped deps.
 * The loop internally builds the agent via createAgentCore(deps), so its
 * runs share this socket's confirm/askUser/onModelDelta bridges.
 */
export const runDefaultLoop: RunLoopFn = async (opts, loopOpts) => {
  const { deps, entries, disposeMcp } = await prepareAgentDeps(opts);
  const task = await expandMcpResources(loopOpts.task, entries, loopOpts.signal);
  return runAutoLoop(deps, { ...loopOpts, task }).finally(() => { deps.runtime?.dispose(); disposeMcp(); });
};

export const resumeDefaultLoop: ResumeLoopFn = async (opts, loopId, loopOpts) => {
  const { deps, disposeMcp } = await prepareAgentDeps(opts);
  return resumeAutoLoop(deps, loopId, loopOpts).finally(() => { deps.runtime?.dispose(); disposeMcp(); });
};
