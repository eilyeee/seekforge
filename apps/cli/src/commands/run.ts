import { createAgentCore, createDeepSeekProvider, createDefaultDispatcher } from "@seekforge/core";
import type { ApprovalMode } from "@seekforge/shared";
import { loadConfig } from "../config.js";
import { confirmInTerminal, renderEvent } from "../render.js";

export type RunOptions = {
  mode: "ask" | "edit";
  yes?: boolean;
  model?: string;
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

  const approvalMode: ApprovalMode = opts.yes ? "auto" : "confirm";
  const agent = createAgentCore({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: opts.model ?? config.model,
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: confirmInTerminal,
  });

  let failed = false;
  for await (const event of agent.runTask({ projectPath, task, mode: opts.mode, approvalMode })) {
    renderEvent(event);
    if (event.type === "session.failed") failed = true;
  }
  if (failed) process.exitCode = 1;
}
