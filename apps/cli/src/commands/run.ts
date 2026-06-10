import { existsSync } from "node:fs";
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRuntimeClient,
  readSessionMeta,
  type RuntimeClient,
} from "@seekforge/core";
import type { ApprovalMode } from "@seekforge/shared";
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

  let runtime: RuntimeClient | undefined;
  if (config.runtimeBin) {
    if (existsSync(config.runtimeBin)) {
      runtime = createRuntimeClient({ binPath: config.runtimeBin });
    } else {
      console.error(`warning: runtimeBin not found (${config.runtimeBin}); using the TypeScript backend`);
    }
  }

  // JSON mode: machine-readable JSONL events, no streaming/colors, and no
  // interactive prompts — anything that would ask is denied (pair with -y).
  const json = opts.json ?? false;
  const render = json
    ? (e: unknown) => console.log(JSON.stringify(e))
    : createRenderer({ streaming: true });
  const approvalMode: ApprovalMode = opts.yes ? "auto" : "confirm";
  const agent = createAgentCore({
    provider: createDeepSeekProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model,
    }),
    dispatcher: createDefaultDispatcher(),
    confirm: json ? async () => false : confirmInTerminal,
    onModelDelta: json ? undefined : (chunk) => process.stdout.write(chunk),
    extractMemory: mode === "edit",
    runtime,
    commandAllowlist: config.commandAllowlist,
  });

  try {
    let failed = false;
    for await (const event of agent.runTask({
      projectPath,
      task: expandFileRefs(task, projectPath),
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
    runtime?.dispose();
  }
}
