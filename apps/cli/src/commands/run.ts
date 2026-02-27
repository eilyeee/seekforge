import { createAgentCore, createDeepSeekProvider, createDefaultDispatcher, readSessionMeta } from "@seekforge/core";
import type { ApprovalMode } from "@seekforge/shared";
import { loadConfig } from "../config.js";
import { confirmInTerminal, createRenderer } from "../render.js";

export type RunOptions = {
  mode: "ask" | "edit";
  yes?: boolean;
  model?: string;
  resumeSessionId?: string;
};

export async function runTaskCommand(task: string, opts: RunOptions): Promise<void> {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);

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

  const render = createRenderer({ streaming: true });
  const approvalMode: ApprovalMode = opts.yes ? "auto" : "confirm";
  const agent = createAgentCore({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: opts.model ?? config.model,
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: confirmInTerminal,
    onModelDelta: (chunk) => process.stdout.write(chunk),
    extractMemory: mode === "edit",
  });

  try {
    let failed = false;
    for await (const event of agent.runTask({
      projectPath,
      task,
      mode,
      approvalMode,
      resumeSessionId: opts.resumeSessionId,
      signal: controller.signal,
    })) {
      render(event);
      if (event.type === "session.failed") failed = true;
    }
    if (failed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
