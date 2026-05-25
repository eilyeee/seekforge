import { createInterface } from "node:readline/promises";
import { listSessions, loadAgentDefinitions, readSessionMeta } from "@seekforge/core";
import type { AgentEvent, ApprovalMode, FinalReport } from "@seekforge/shared";
import { createCliAgent, prepareMcp } from "../agent-factory.js";
import { colorIsEnabled, fail } from "../colors.js";
import { loadConfig } from "../config.js";
import { expandFileRefs } from "../file-refs.js";
import {
  buildResultEnvelope,
  createStreamJsonMapper,
  isMachineFormat,
  outcomeFromErrorCode,
  type OutputFormat,
  type ResultOutcome,
} from "../output-format.js";
import { confirmInTerminal, createRenderer } from "../render.js";
import { outputStylePrompt } from "../output-style.js";
import { readStreamJsonInput } from "../stream-input.js";
import { buildToolGatingRules } from "../tool-gating.js";
import { expandExtraFileRefs, normalizeExtraDir } from "../workspace-dirs.js";

export type RunOptions = {
  mode: "ask" | "edit";
  yes?: boolean;
  model?: string;
  resumeSessionId?: string;
  /** Resume the most recent session (`-c`/`--continue`). */
  continueLast?: boolean;
  /** Output format: text (human) | json (final object) | stream-json (JSONL). */
  outputFormat?: OutputFormat;
  /** Plan first (read-only), then ask before executing in the same session. */
  plan?: boolean;
  /** Extra read-only roots whose @path references resolve. */
  addDirs?: string[];
  /** Cap on agent turns (limits.maxAgentTurns). */
  maxTurns?: number;
  /** Verbose tool args/results in text mode. */
  verbose?: boolean;
  /** Full system-prompt override (CLI --system-prompt → core systemPromptOverride). */
  systemPrompt?: string;
  /** Append text to the system prompt (CLI --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Comma-separated allow-list of tools (CLI --allowedTools). */
  allowedTools?: string;
  /** Comma-separated deny-list of tools (CLI --disallowedTools). */
  disallowedTools?: string;
  /**
   * Permission mode (CLI --permission-mode). Claude-compatible names map onto
   * the core ApprovalMode: default→confirm, acceptEdits→acceptEdits,
   * bypassPermissions→auto, plan→confirm+plan. Native names also accepted.
   * Overrides -y when set.
   */
  permissionMode?: string;
  /** Model to retry with if the primary is overloaded (CLI --fallback-model). */
  fallbackModel?: string;
  /** Output style preset appended to the system prompt (CLI --output-style). */
  outputStyle?: string;
  /** Path to a JSON settings file (CLI --settings). */
  settingsFile?: string;
  /** Input format (CLI --input-format). "stream-json" drives multi-turn from stdin. */
  inputFormat?: string;
};

export async function runTaskCommand(task: string, opts: RunOptions): Promise<void> {
  const projectPath = process.cwd();
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath, opts.settingsFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return;
  }
  const format: OutputFormat = opts.outputFormat ?? "text";
  const machine = isMachineFormat(format);


  const model = opts.model ?? config.model;
  if (model === "deepseek-reasoner") {
    // reasoner has no function calling; the fallback text protocol is not
    // wired into the loop yet (planned). Refuse instead of failing midway.
    fail("deepseek-reasoner does not support tool calling and cannot drive the agent yet", {
      hint: "use deepseek-v4-flash (default)",
    });
    return;
  }

  if (!config.apiKey) {
    fail("no DeepSeek API key found", {
      hint: 'set DEEPSEEK_API_KEY, or put {"apiKey": "..."} in .seekforge/config.json (project) or ~/.seekforge/config.json (global)',
    });
    return;
  }

  // Resolve which session (if any) to resume: explicit --resume wins over -c.
  let resumeSessionId = opts.resumeSessionId;
  if (!resumeSessionId && opts.continueLast) {
    const recent = listSessions(projectPath)[0];
    if (!recent) {
      fail("no previous session to continue", { hint: "run a task first" });
      return;
    }
    resumeSessionId = recent.id;
  }

  let mode = opts.mode;
  if (resumeSessionId) {
    const meta = readSessionMeta(projectPath, resumeSessionId);
    if (!meta) {
      fail(`session "${resumeSessionId}" not found`, { hint: "see `seekforge sessions`" });
      return;
    }
    mode = meta.mode; // a resumed session keeps its original ask/edit mode
  }

  // Normalize --add-dir roots (existing dirs outside the project); warn & skip bad ones.
  const extraDirs: string[] = [];
  for (const raw of opts.addDirs ?? []) {
    const abs = normalizeExtraDir(raw, projectPath);
    if (abs) extraDirs.push(abs);
    else console.error(`warning: --add-dir "${raw}" skipped (not an existing dir outside the project)`);
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

  // Machine formats (json/stream-json): no streaming/colors, and no interactive
  // prompts — anything that would ask is denied (pair with -y). Reasoning
  // deltas are also suppressed (they are a stdout stream, not events).
  // color: false in machine mode is belt-and-suspenders — the renderer is also
  // skipped entirely below — but it documents intent and guards the delta sinks.
  const renderer = machine
    ? undefined
    : createRenderer({ streaming: true, verbose: opts.verbose, color: colorIsEnabled() });
  // stream-json: Claude-style SDK envelopes (system/assistant/user) per line via
  // the mapper, with the final result envelope appended after the stream.
  // stream-json-raw: the OLD behavior — one raw AgentEvent per line.
  // json: buffer everything, emit one result envelope at the end.
  const streamMapper = format === "stream-json" ? createStreamJsonMapper() : undefined;
  const render =
    format === "stream-json"
      ? (e: AgentEvent) => {
          for (const env of streamMapper!.map(e)) console.log(JSON.stringify(env));
        }
      : format === "stream-json-raw"
        ? (e: AgentEvent) => console.log(JSON.stringify(e))
        : renderer
          ? renderer.render
          : () => {}; // json: swallow events, emit one final object at the end
  // --permission-mode maps Claude-compatible (and native) names onto ApprovalMode;
  // "plan" additionally forces plan-first. When unset, -y → auto, else confirm.
  let approvalMode: ApprovalMode = opts.yes ? "auto" : "confirm";
  let planFromMode = false;
  if (opts.permissionMode) {
    switch (opts.permissionMode) {
      case "default":
      case "confirm":
        approvalMode = "confirm";
        break;
      case "acceptEdits":
        approvalMode = "acceptEdits";
        break;
      case "bypassPermissions":
      case "auto":
        approvalMode = "auto";
        break;
      case "plan":
        approvalMode = "confirm";
        planFromMode = true;
        break;
      default:
        fail(`unknown --permission-mode "${opts.permissionMode}"`, {
          hint: "default | acceptEdits | plan | bypassPermissions (also: confirm | auto)",
        });
        return;
    }
  }
  const planMode = (opts.plan ?? false) || planFromMode;

  // --output-style appends a communication-style preset to the system prompt,
  // combined with any explicit --append-system-prompt.
  let styleAddendum: string | undefined;
  if (opts.outputStyle) {
    try {
      styleAddendum = outputStylePrompt(opts.outputStyle);
    } catch {
      fail(`unknown --output-style "${opts.outputStyle}"`, {
        hint: "default | concise | explanatory | learning",
      });
      return;
    }
  }
  const effectiveAppend =
    [styleAddendum, opts.appendSystemPrompt].filter((s): s is string => !!s).join("\n\n") || undefined;

  const mcp = await prepareMcp(config, projectPath);

  // --allowedTools/--disallowedTools synthesize per-run permission rules,
  // prepended to any config rules. undefined when neither flag is used.
  const permissionRules = buildToolGatingRules({
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    base: config.permissionRules,
  });

  const { agent, dispose } = createCliAgent({
    config,
    model,
    mcpToolSpecs: mcp.specs,
    confirm: machine ? async () => false : confirmInTerminal,
    onModelDelta: renderer?.modelDelta,
    onReasoningDelta: renderer?.reasoningDelta,
    extractMemory: mode === "edit",
    subagents: loadAgentDefinitions(projectPath),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(permissionRules ? { permissionRules } : {}),
    ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
  });

  // @-references resolve against the workspace first, then any extra dirs.
  const expand = (t: string): string => expandExtraFileRefs(expandFileRefs(t, projectPath), extraDirs);

  let finalReport: FinalReport | undefined;
  // Run accounting for the result envelope (json + stream-json final line).
  const startedAt = Date.now();
  let numTurns = 0; // assistant text turns observed across runOnce calls
  let outcome: ResultOutcome = { kind: "success" };

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
      ...(opts.systemPrompt !== undefined ? { systemPromptOverride: opts.systemPrompt } : {}),
      ...(effectiveAppend !== undefined ? { appendSystemPrompt: effectiveAppend } : {}),
    })) {
      render(event);
      if (event.type === "model.message") numTurns++;
      if (event.type === "session.created") sessionId = event.sessionId;
      if (event.type === "session.completed") {
        completed = true;
        finalReport = event.report;
      }
      if (event.type === "session.failed") {
        outcome = outcomeFromErrorCode(event.error.code, event.error.message);
      }
    }
    return { sessionId, completed };
  };

  // Emits the final Claude-compatible result envelope: pretty-printed for `json`,
  // one JSONL line (via the stream mapper) for `stream-json`. No-op otherwise.
  const emitResult = (sessionId: string | undefined): void => {
    if (format !== "json" && format !== "stream-json") return;
    const input = {
      ...(finalReport ? { report: finalReport } : {}),
      sessionId,
      numTurns,
      durationMs: Date.now() - startedAt,
      outcome: finalReport ? outcome : outcome.kind === "success" ? { kind: "error" as const } : outcome,
    };
    if (format === "stream-json") {
      console.log(JSON.stringify(streamMapper!.result(input)));
    } else {
      console.log(JSON.stringify(buildResultEnvelope(input), null, 2));
    }
  };

  try {
    // --input-format stream-json: read line-delimited user turns from stdin and
    // drive a multi-turn session, chaining each turn onto the prior session id.
    if (opts.inputFormat === "stream-json") {
      let sid = resumeSessionId;
      let turns = 0;
      let lastCompleted = true;
      for await (const turnText of readStreamJsonInput(process.stdin)) {
        turns++;
        const r = await runOnce({ task: expand(turnText), mode, resumeSessionId: sid });
        sid = r.sessionId ?? sid;
        lastCompleted = r.completed;
        if (!r.completed) break;
      }
      if (turns === 0) {
        fail("stream-json input: no user turns received on stdin");
        return;
      }
      emitResult(sid);
      if (!lastCompleted) process.exitCode = 1;
      return;
    }

    // Plan mode requires interactive confirmation, so only the human text
    // format supports it (machine formats run straight through).
    if (planMode && !machine) {
      const planRun = await runOnce({ task: expand(task), mode: "ask", plan: true });
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

    const run = await runOnce({ task: expand(task), mode, resumeSessionId });
    emitResult(run.sessionId);
    if (!run.completed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
  }
}
