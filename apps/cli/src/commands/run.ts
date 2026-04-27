import { createInterface } from "node:readline/promises";
import { loadAgentDefinitions, readSessionMeta } from "@seekforge/core";
import type { ApprovalMode } from "@seekforge/shared";
import { createCliAgent, prepareMcp } from "../agent-factory.js";
import { loadConfig } from "../config.js";
import { expandFileRefs } from "../file-refs.js";
import { confirmInTerminal, createRenderer } from "../render.js";

export type RunOptions = {
  mode: "ask" | "edit";
  yes?: boolean;
  model?: string;
  resumeSessionId?: string;
  /** Emit one JSON event per line instead of human-readable output. */
  json?: boolean;
  /** Plan first (read-only), then ask before executing in the same session. */
  plan?: boolean;
};

export async function runTaskCommand(task: string, opts: RunOptions): Promise<void> {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);

  const model = opts.model ?? config.model;
  if (model === "deepseek-reasoner") {
    // reasoner has no function calling; the fallback text protocol is not
    // wired into the loop yet (planned). Refuse instead of failing midway.
    console.error(
      "deepseek-reasoner does not support tool calling and is not usable as the agent model yet. " +
        "Use deepseek-chat (default).",
    );
    process.exitCode = 1;
    return;
  }

  if (!config.apiKey) {
    console.error(
      "No DeepSeek API key found. Set DEEPSEEK_API_KEY, or put {\"apiKey\": \"...\"} in " +
        ".seekforge/config.json (project) or ~/.seekforge/config.json (global).",
    );
    process.exitCode = 1;
    return;
  }

  let mode = opts.mode;
  if (opts.resumeSessionId) {
    const meta = readSessionMeta(projectPath, opts.resumeSessionId);
    if (!meta) {
      console.error(`Session "${opts.resumeSessionId}" not found. See \`seekforge sessions\`.`);
      process.exitCode = 1;
      return;
    }
    mode = meta.mode; // a resumed session keeps its original ask/edit mode
  }

  // Ctrl+C: first press cancels cooperatively (session marked cancelled,
  // trace preserved for `seekforge resume`); second press force-exits.
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.error("\ncancelling… (press Ctrl+C again to force quit)");
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  // JSON mode: machine-readable JSONL events, no streaming/colors, and no
  // interactive prompts — anything that would ask is denied (pair with -y).
  // Reasoning deltas are also suppressed (they are a stdout stream, not events).
  const json = opts.json ?? false;
  const renderer = json ? undefined : createRenderer({ streaming: true });
  const render = renderer ? renderer.render : (e: unknown) => console.log(JSON.stringify(e));
  const approvalMode: ApprovalMode = opts.yes ? "auto" : "confirm";
  const mcp = await prepareMcp(config);
  const { agent, dispose } = createCliAgent({
    config,
    model,
    mcpToolSpecs: mcp.specs,
    confirm: json ? async () => false : confirmInTerminal,
    onModelDelta: renderer?.modelDelta,
    onReasoningDelta: renderer?.reasoningDelta,
    extractMemory: mode === "edit",
    subagents: loadAgentDefinitions(projectPath),
  });

  const runOnce = async (input: {
    task: string;
    mode: "ask" | "edit";
    plan?: boolean;
    resumeSessionId?: string;
  }): Promise<{ sessionId?: string; completed: boolean }> => {
    let sessionId: string | undefined;
    let completed = false;
    for await (const event of agent.runTask({
      projectPath,
      task: input.task,
      mode: input.mode,
      plan: input.plan,
      approvalMode,
      resumeSessionId: input.resumeSessionId,
      signal: controller.signal,
    })) {
      render(event);
      if (event.type === "session.created") sessionId = event.sessionId;
      if (event.type === "session.completed") completed = true;
    }
    return { sessionId, completed };
  };

  try {
    if (opts.plan && !json) {
      // Plan mode: read-only investigation first, then execute on approval
      // in the SAME session (the loop rebuilds the system prompt for edit).
      const planRun = await runOnce({
        task: expandFileRefs(task, projectPath),
        mode: "ask",
        plan: true,
      });
      if (!planRun.completed || !planRun.sessionId) {
        process.exitCode = 1;
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer: string;
      try {
        answer = (await rl.question("\nExecute this plan? [y/N] ")).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (answer !== "y") {
        console.log(`plan kept, nothing executed (resume later: seekforge resume ${planRun.sessionId})`);
        return;
      }
      const execRun = await runOnce({
        task: "Execute the plan you produced above, step by step. Make the changes and run the verification.",
        mode: "edit",
        resumeSessionId: planRun.sessionId,
      });
      if (!execRun.completed) process.exitCode = 1;
      return;
    }

    const run = await runOnce({
      task: expandFileRefs(task, projectPath),
      mode,
      resumeSessionId: opts.resumeSessionId,
    });
    if (!run.completed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
  }
}
