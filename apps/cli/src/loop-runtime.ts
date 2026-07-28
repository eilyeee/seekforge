import { loadAgentDefinitions, type AgentCoreDeps } from "@seekforge/core";
import { createCliAgentDeps, prepareMcp } from "./agent-factory.js";
import type { loadConfig } from "./config.js";

export type LoopRuntime = { deps: AgentCoreDeps; controller: AbortController };

/** Owns MCP, agent dependencies, and SIGINT cleanup for one foreground Loop command. */
export async function withAgentRuntime<T>(
  options: {
    config: ReturnType<typeof loadConfig>;
    workspace: string;
    model?: string;
    extractMemory: boolean;
    forceOnSecondSigint?: boolean;
    onCancel?: () => void;
  },
  run: (runtime: LoopRuntime) => Promise<T>,
): Promise<T> {
  const mcp = await prepareMcp(options.config, options.workspace);
  let dispose: (() => void) | undefined;
  try {
    const created = createCliAgentDeps({
      config: options.config,
      workspace: options.workspace,
      pluginContributions: mcp.pluginContributions,
      model: options.model,
      mcpToolSpecs: mcp.specs,
      confirm: async () => false,
      extractMemory: options.extractMemory,
      subagents: loadAgentDefinitions(options.workspace, mcp.pluginContributions),
    });
    dispose = created.dispose;
    const controller = new AbortController();
    const onSigint = () => {
      if (controller.signal.aborted && options.forceOnSecondSigint) process.exit(130);
      controller.abort();
      try {
        options.onCancel?.();
      } catch {
        // Rendering cancellation must not prevent the control signal.
      }
    };
    process.on("SIGINT", onSigint);
    try {
      return await run({ deps: created.deps, controller });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  } finally {
    try {
      dispose?.();
    } finally {
      mcp.dispose();
    }
  }
}

/** Backward-compatible Loop-specific name. */
export const withLoopAgentRuntime = withAgentRuntime;
