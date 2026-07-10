import {
  loadAgentDefinitions,
  runAutoLoop,
  type LoopEvent,
  type LoopResult,
  type ToolSpec,
} from "@seekforge/core";
import type { TuiConfig } from "../config.js";
import { expandFileRefs } from "@seekforge/shared/file-refs";
import { buildTuiDeps } from "./factory.js";

export type RunLoopDeps = {
  config: TuiConfig;
  model: string;
  projectPath: string;
  mcpToolSpecs: ToolSpec[];
  /** Max run→verify iterations before giving up (caller supplies the default). */
  maxIterations: number;
  /** Forwards each LoopEvent to the caller for transcript rendering. */
  onEvent: (event: LoopEvent) => void;
};

/**
 * Drives one autonomous run→verify loop: assembles the SAME agent deps
 * run-session builds (via buildTuiDeps), then hands them to CORE's runAutoLoop.
 * Mirrors run-session.ts but reuses CORE's loop engine instead of driving a
 * single turn.
 *
 * The loop can never stop to ask a human, so it runs in acceptEdits (edits
 * auto-apply) and denies anything else not already permitted (confirm → false),
 * matching the CLI `loop` command and the desktop LoopPanel. Cancellation is
 * cooperative via `signal`.
 */
export async function runLoop(
  task: string,
  verifyCommand: string,
  signal: AbortSignal,
  deps: RunLoopDeps,
): Promise<LoopResult> {
  const { deps: agentDeps, dispose } = buildTuiDeps({
    config: deps.config,
    model: deps.model,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(deps.projectPath),
    mcpToolSpecs: deps.mcpToolSpecs,
  });

  try {
    return await runAutoLoop(agentDeps, {
      task: expandFileRefs(task, deps.projectPath),
      workspace: deps.projectPath,
      verifyCommand,
      maxIterations: deps.maxIterations,
      approvalMode: "acceptEdits",
      signal,
      onEvent: deps.onEvent,
    });
  } finally {
    dispose();
  }
}
