import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  buildProvider,
  createUsageBus,
  forkSession,
  loadAgentDefinitions,
  produceStructuredOutput,
  resolvedPricingSource,
  withInlineAgents,
} from "@seekforge/core";
import type { AgentEvent, ApprovalMode, FinalReport, TokenUsage } from "@seekforge/shared";
import { cliMcpServerRequestHandlers, createCliAgent, prepareMcp } from "../agent-factory.js";
import { colorIsEnabled, fail } from "../colors.js";
import { loadConfig, type CliConfig } from "../config.js";
import { expandFileRefs } from "@seekforge/shared/file-refs";
import {
  buildResultEnvelope,
  createStreamJsonMapper,
  isMachineFormat,
  outcomeFromErrorCode,
  type OutputFormat,
  type ResultOutcome,
} from "../output-format.js";
import { t } from "../i18n.js";
import { resolvePermissionMode, UnknownPermissionModeError } from "../permission-mode.js";
import { confirmInTerminal, createRenderer } from "../render.js";
import { authorizeDir, isAuthorizedDir } from "../authorized-dirs.js";
import { isCostBudgetExceeded } from "../cost-budget.js";
import { elapsedSeconds, resolveDurationBudgetMs } from "../run-deadline.js";
import { readStreamJsonInput } from "../stream-input.js";
import { buildToolGatingRules, parseToolList } from "../tool-gating.js";
import { expandExtraFileRefs, normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import { apiKeyEnvVar } from "@seekforge/shared/provider-env";
import { createDebugLogger, type DebugLogger } from "../debug-log.js";
import { createRunWorktree, repositoryPrefix, type LoopWorktree } from "../loop-worktree.js";
import {
  loadJsonSchemaFlag,
  parseAgentsFlag,
  resolveMcpServers,
  resolvePromptFlags,
  resolveSessionFlags,
  RunSetupError,
} from "../run-setup.js";

export type RunOptions = {
  mode: "ask" | "edit";
  yes?: boolean;
  model?: string;
  resumeSessionId?: string;
  /** Resume the most recent session (`-c`/`--continue`). */
  continueLast?: boolean;
  /** Continue the resumed session in a forked copy (`--fork-session`). */
  forkSession?: boolean;
  /** Id for the new session this run creates (`--session-id`). */
  sessionId?: string;
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
  /** File whose contents replace the system prompt (CLI --system-prompt-file). */
  systemPromptFile?: string;
  /** Append text to the system prompt (CLI --append-system-prompt). */
  appendSystemPrompt?: string;
  /** File whose contents are appended to the system prompt (CLI --append-system-prompt-file). */
  appendSystemPromptFile?: string;
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
  /** Named config profile to overlay (CLI --profile / SEEKFORGE_PROFILE). */
  profile?: string;
  /** Input format (CLI --input-format). "stream-json" drives multi-turn from stdin. */
  inputFormat?: string;
  /** Alias for `yes` (CLI --dangerously-skip-permissions) → approvalMode auto. */
  dangerouslySkipPermissions?: boolean;
  /** Path to a JSON file of MCP servers (CLI --mcp-config); merged over config. */
  mcpConfig?: string;
  /** Use only --mcp-config servers, ignore config-file ones (CLI --strict-mcp-config). */
  strictMcpConfig?: boolean;
  /** stream-json input: echo each user turn back as a stream event (--replay-user-messages). */
  replayUserMessages?: boolean;
  /** stream-json output: emit partial assistant text deltas (--include-partial-messages). */
  includePartialMessages?: boolean;
  /** Inline, run-scoped subagent definitions (CLI --agents JSON). */
  agentsJson?: string;
  /** Internal detail on stderr (CLI --debug [filter]); true = every category. */
  debug?: boolean | string;
  /** Run inside a new retained git worktree, optionally named (CLI --worktree [name]). */
  worktree?: boolean | string;
  /** JSON Schema the run's structured output must validate against (CLI --json-schema). */
  jsonSchema?: string;
  /** File holding that schema (CLI --json-schema-file). */
  jsonSchemaFile?: string;
  /**
   * Per-run cost budget in USD (CLI --max-cost). The run aborts gracefully once
   * cumulative cost reaches it. Falls back to config.maxCostUsd; off when both
   * are absent/non-positive.
   */
  maxCostUsd?: number;
  /**
   * Per-run wall-clock budget in seconds (CLI --max-duration). The run aborts
   * gracefully once the deadline passes, whether or not anything is happening.
   * Falls back to config.maxDurationSeconds; off when both are absent.
   */
  maxDurationSeconds?: number;
  /**
   * Per-run ceiling on cumulative tokens (prompt + completion). Independent of
   * cost, so an UNATTENDED run stays bounded on a provider with no price table
   * (where costUsd is always 0 and `maxCostUsd` can never trip). Set by the
   * headless callers that have no human watching — `schedule run` — not by a
   * user-facing flag; off when unset/non-positive.
   */
  maxTotalTokens?: number;
  /**
   * Suppress the final result envelope on stdout even in a machine format.
   * The scheduler uses `outputFormat: "json"` only to force confirm-auto-deny
   * (headless ticks must never block on a prompt) — it does NOT want the
   * envelope printed into its own output, which would corrupt `schedule run
   * --json` (two JSON objects per job) and clutter the human view.
   */
  suppressResult?: boolean;
};

/**
 * Folder-access consent: returns true if `dir` may be accessed. Authorized dirs
 * pass silently; `-y` pre-authorizes; an interactive TTY prompts once (and
 * remembers a yes); a non-interactive run without `-y` is refused.
 */
export async function ensureWorkspaceAuthorized(
  dir: string,
  { yes, machine }: { yes: boolean; machine: boolean },
): Promise<boolean> {
  if (isAuthorizedDir(dir)) return true;
  if (yes) {
    authorizeDir(dir);
    return true;
  }
  if (machine || !process.stdin.isTTY) {
    fail(t("err.workspaceNotAuthorized", { dir }), { hint: t("err.workspaceNotAuthorizedHint") });
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(t("render.authorizeWorkspacePrompt", { dir }))).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      authorizeDir(dir);
      return true;
    }
    fail(t("err.workspaceAuthDeclined"));
    return false;
  } finally {
    rl.close();
  }
}

/** One-line summaries of config state worth seeing under `--debug config`. */
export function debugConfigLines(config: CliConfig, opts: { settingsFile?: string; profile?: string }): string[] {
  const hooks = Object.entries(config.hooks ?? {})
    .filter(([, entries]) => Array.isArray(entries) && entries.length > 0)
    .map(([stage, entries]) => `${stage}×${(entries as unknown[]).length}`);
  return [
    `provider=${config.provider ?? "deepseek"} model=${config.model ?? "(default)"}` +
      `${opts.settingsFile ? ` settings=${opts.settingsFile}` : ""}` +
      `${(opts.profile ?? process.env["SEEKFORGE_PROFILE"]) ? ` profile=${opts.profile ?? process.env["SEEKFORGE_PROFILE"]}` : ""}`,
    `permissionRules=${config.permissionRules?.length ?? 0} sandbox=${config.sandbox ?? "off"} compaction=${config.compaction ?? "mechanical"}`,
    `hooks: ${hooks.length > 0 ? hooks.join(" ") : "none"}`,
  ];
}

/** MCP servers as `--debug mcp` reports them: name plus whether discovery may start it. */
export function debugMcpLine(config: CliConfig, toolCount: number): string {
  const servers = Object.entries(config.mcpServers ?? {}).map(
    ([name, server]) => `${name}${(server as { trusted?: boolean }).trusted === true ? "" : " (untrusted, skipped)"}`,
  );
  return `${servers.length} configured server(s)${servers.length > 0 ? `: ${servers.join(", ")}` : ""}; ${toolCount} tool(s) loaded`;
}

/** What the structured-output call is told the run produced. */
export function describeReportForStructuredOutput(report: FinalReport): string {
  return [
    report.summary,
    "",
    `Changed files: ${report.changedFiles.length > 0 ? report.changedFiles.join(", ") : "(none)"}`,
    `Commands run: ${report.commandsRun.length > 0 ? report.commandsRun.join("; ") : "(none)"}`,
    `Verification: ${report.verification}`,
  ].join("\n");
}

function formatRunWorktree(worktree: LoopWorktree): string {
  return t("render.worktreeRetained", { path: worktree.path, branch: worktree.branch });
}

/**
 * Runs a headless agent task. Returns `true` iff the agent run COMPLETED
 * successfully (a final report was produced); returns `false` on any guard
 * failure, error, cancellation, or budget cutoff. Callers that gate a
 * side effect on success (e.g. `resolve` committing/pushing) MUST check it —
 * `process.exitCode` alone is not reliable for every early-return path.
 */
export async function runTaskCommand(task: string, opts: RunOptions): Promise<boolean> {
  const basePath = process.cwd();
  const debug: DebugLogger = createDebugLogger(opts.debug);
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(basePath, opts.settingsFile, opts.profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return false;
  }
  for (const line of debugConfigLines(config, opts)) debug.log("config", line);
  const format: OutputFormat = opts.outputFormat ?? "text";
  const machine = isMachineFormat(format);

  const model = opts.model ?? config.model;
  if (model === "deepseek-reasoner") {
    // reasoner has no function calling, and there is deliberately no text
    // protocol that would parse tool calls out of prose — assistant text and
    // tool output share one untrusted channel. Refuse instead of failing midway.
    fail(t("err.reasonerNoToolCall"), {
      hint: t("err.reasonerHint"),
    });
    return false;
  }

  if (!config.apiKey) {
    fail(t("err.noApiKey"), {
      hint: t("err.noApiKeyHint2", { keyEnv: apiKeyEnvVar(config.provider) }),
    });
    return false;
  }

  // A hand-written config.maxCostUsd of the wrong type (e.g. the string "0.01")
  // would otherwise crash later at .toFixed() when the budget is hit. Fail fast
  // with a clear config error. The --max-cost flag is already number-validated.
  if (
    config.maxCostUsd !== undefined &&
    (typeof config.maxCostUsd !== "number" || !Number.isFinite(config.maxCostUsd))
  ) {
    fail(t("err.maxCostUsdNumber"), { hint: t("err.maxCostUsdNumberHint") });
    return false;
  }

  // Same fail-fast for a hand-written maxDurationSeconds: silently ignoring a
  // budget someone configured is the one behavior a budget must never have.
  if (
    config.maxDurationSeconds !== undefined &&
    (typeof config.maxDurationSeconds !== "number" || !Number.isFinite(config.maxDurationSeconds))
  ) {
    fail(t("err.maxDurationNumber"), { hint: t("err.maxDurationNumberHint") });
    return false;
  }

  // --permission-mode maps Claude-compatible (and native) names onto ApprovalMode;
  // "plan" additionally forces plan-first. When unset, -y → auto, else confirm.
  // -y and --dangerously-skip-permissions both map to approvalMode "auto"
  // (auto-approve write/execute). "auto" is NOT literally every tool: the
  // denylist still refuses dangerous calls and env changes still ask.
  // The mapping itself is a pure helper (see permission-mode.ts) so it can be
  // unit-tested; here we just surface an unknown mode as a CLI fail().
  let approvalMode: ApprovalMode;
  let planFromMode: boolean;
  try {
    ({ approvalMode, planFromMode } = resolvePermissionMode({
      yes: opts.yes,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      permissionMode: opts.permissionMode,
    }));
  } catch (err) {
    if (err instanceof UnknownPermissionModeError) {
      fail(t("err.unknownPermissionMode", { mode: err.mode }), {
        hint: t("err.unknownPermissionModeHint"),
      });
      return false;
    }
    throw err;
  }
  const planMode = (opts.plan ?? false) || planFromMode;

  // Every remaining flag is validated before anything has an effect: the
  // workspace consent, a session fork, a worktree and MCP servers all come after.
  const wantsWorktree = opts.worktree !== undefined && opts.worktree !== false;
  let prompts: ReturnType<typeof resolvePromptFlags>;
  let jsonSchema: unknown;
  let inlineAgents: ReturnType<typeof parseAgentsFlag>;
  let sessionPlan: ReturnType<typeof resolveSessionFlags>;
  let mcpConfigForRun: CliConfig;
  try {
    prompts = resolvePromptFlags(opts, basePath);
    jsonSchema = loadJsonSchemaFlag(opts);
    if (jsonSchema !== undefined && opts.inputFormat === "stream-json") {
      throw new RunSetupError(t("err.jsonSchemaStreamInput"));
    }
    inlineAgents = parseAgentsFlag(opts.agentsJson);
    // A session lives in the checkout that ran it, so it cannot move into a new worktree.
    if (wantsWorktree && (opts.resumeSessionId !== undefined || opts.continueLast || opts.forkSession)) {
      throw new RunSetupError(t("err.worktreeConflict"));
    }
    sessionPlan = resolveSessionFlags(basePath, {
      continueLast: opts.continueLast,
      resumeSessionId: opts.resumeSessionId,
      forkSession: opts.forkSession,
      sessionId: opts.sessionId,
    });
    mcpConfigForRun = resolveMcpServers(config, opts);
  } catch (err) {
    if (err instanceof RunSetupError) {
      fail(err.message, err.hint ? { hint: err.hint } : undefined);
      return false;
    }
    throw err;
  }
  const effectiveAppend = prompts.appendSystemPrompt;
  // --allowedTools/--disallowedTools synthesize per-run permission rules,
  // prepended to any config rules. undefined when neither flag is used.
  const permissionRules = buildToolGatingRules({
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    base: config.permissionRules,
  });
  const allowedTools = parseToolList(opts.allowedTools);

  // Folder-access consent: SeekForge must be authorized for this directory once
  // (interactively, or via -y) before it reads/edits files here.
  if (!(await ensureWorkspaceAuthorized(basePath, { yes: opts.yes === true, machine }))) {
    return false;
  }

  // A resumed session keeps its original ask/edit mode.
  const mode = sessionPlan.resumeMode ?? opts.mode;
  let resumeSessionId = sessionPlan.resumeSessionId;
  if (sessionPlan.fork && resumeSessionId !== undefined) {
    let forked: string | null;
    try {
      forked = forkSession(basePath, resumeSessionId);
    } catch (err) {
      fail(t("err.forkFailed", { id: resumeSessionId }), {
        hint: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!forked) {
      fail(t("err.forkFailed", { id: resumeSessionId }), { hint: t("err.sessionNotFoundHint") });
      return false;
    }
    console.error(t("render.forkedSession", { from: resumeSessionId, id: forked }));
    debug.log("session", `forked ${resumeSessionId} -> ${forked}`);
    resumeSessionId = forked;
  }

  let projectPath = basePath;
  let worktree: LoopWorktree | undefined;
  if (wantsWorktree) {
    try {
      const prefix = await repositoryPrefix(basePath);
      worktree = await createRunWorktree(basePath, typeof opts.worktree === "string" ? opts.worktree : undefined);
      // Run from the same subdirectory of the new checkout the user is in. A
      // directory git does not track is not in the new checkout at all.
      projectPath = prefix ? join(worktree.path, prefix) : worktree.path;
      if (!existsSync(projectPath)) throw new Error(t("err.worktreeNoPrefix", { prefix, path: worktree.path }));
    } catch (err) {
      fail(t("err.worktreeFailed", { message: err instanceof Error ? err.message : String(err) }));
      return false;
    }
    console.error(t("render.worktreeCreated", { path: worktree.path, branch: worktree.branch }));
    debug.log("worktree", `created ${worktree.path} on ${worktree.branch}; agent workspace ${projectPath}`);
  }

  // Normalize --add-dir roots (existing dirs outside the project); warn & skip bad ones.
  const extraDirs: string[] = [];
  for (const raw of opts.addDirs ?? []) {
    const abs = normalizeExtraDir(raw, projectPath);
    if (abs) extraDirs.push(abs);
    else console.error(t("err.excludedDirSkipped", { dir: raw }));
  }

  // Ctrl+C: first press cancels cooperatively (session marked cancelled,
  // trace preserved for `seekforge resume`); second press force-exits.
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.error(t("render.cancelling"));
    controller.abort();
  };
  // Resolved here with the other budgets; armed further down, next to the try
  // that clears it (see the deadline block).
  const durationBudgetMs = resolveDurationBudgetMs(opts.maxDurationSeconds, config.maxDurationSeconds);
  // --max-cost (or config.maxCostUsd): stop the run once cumulative cost
  // reaches the budget by aborting the same controller Ctrl+C uses (graceful
  // cancel, trace kept). Off when unset/non-positive. We compare the SESSION
  // window of every usage snapshot (see sessionTotals below): one invocation
  // can chain several runs over one session (stream-json turns, plan →
  // execute) and --resume continues a session that already spent, so the
  // per-run window would hand the same budget out again on every run.
  const costBudgetUsd = opts.maxCostUsd ?? config.maxCostUsd;
  // A budget on a run whose price is unknown is a bound that can never be
  // reached: every request reports 0, so the comparison below never fires. That
  // is worse than having no budget, because the user believes there is one.
  if (
    costBudgetUsd !== undefined &&
    costBudgetUsd > 0 &&
    resolvedPricingSource({
      provider: config.provider,
      model: opts.model ?? config.model,
      ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
    }) === "unavailable"
  ) {
    console.error(t("render.costBudgetUnenforceable", { budget: costBudgetUsd.toFixed(4) }));
  }
  let costBudgetReached = false;
  const enforceCostBudget = (costUsd: number): void => {
    if (costBudgetReached || controller.signal.aborted) return;
    if (!isCostBudgetExceeded(costUsd, costBudgetUsd)) return;
    costBudgetReached = true;
    console.error(t("render.costBudgetReached", { budget: (costBudgetUsd as number).toFixed(4) }));
    controller.abort();
  };

  // Token ceiling — the backstop for the case above. When no price is known the
  // cost budget can never be reached, so an unattended run (a scheduled tick)
  // would have no bound at all. Tokens are reported by every provider, priced
  // or not. SOFT/reactive like the cost budget: we abort on the first usage
  // event at/over the ceiling, so the in-flight turn can overshoot by one call.
  const tokenCeiling = opts.maxTotalTokens;
  let tokenCeilingReached = false;
  const enforceTokenCeiling = (promptTokens: number, completionTokens: number): void => {
    if (tokenCeiling === undefined || tokenCeiling <= 0) return;
    if (tokenCeilingReached || controller.signal.aborted) return;
    if (promptTokens + completionTokens < tokenCeiling) return;
    tokenCeilingReached = true;
    console.error(t("render.tokenCeilingReached", { ceiling: String(tokenCeiling) }));
    controller.abort();
  };

  /**
   * The window every budget here is measured in. Core publishes each usage
   * snapshot in two windows and the session one already includes the runs a
   * resume continues, so the budgets never add anything up themselves.
   */
  const sessionTotals = (snapshot: { usage: TokenUsage; sessionUsage?: TokenUsage }): TokenUsage =>
    snapshot.sessionUsage ?? snapshot.usage;
  const enforceBudgets = (totals: TokenUsage): void => {
    enforceCostBudget(totals.costUsd);
    enforceTokenCeiling(totals.promptTokens, totals.completionTokens);
  };

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
  // --include-partial-messages: with stream-json, emit each assistant text delta
  // as a Claude-style content_block_delta stream event (for SDK consumers).
  const emitPartial =
    format === "stream-json" && opts.includePartialMessages
      ? (chunk: string) =>
          console.log(
            JSON.stringify({
              type: "stream_event",
              event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } },
            }),
          )
      : undefined;
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

  // stream-json input consumes process.stdin as an async generator; a live
  // terminal prompt would race it for the same fd and corrupt the next
  // envelope. Deny automatically in that mode (as `machine` output already does).
  const confirm = machine || opts.inputFormat === "stream-json" ? async () => false : confirmInTerminal;
  // Shared by the MCP sampling handler and the agent, so a server's model calls
  // land in this run's usage rather than only on stderr.
  const usageBus = createUsageBus();
  const mcp = await prepareMcp(
    mcpConfigForRun,
    projectPath,
    cliMcpServerRequestHandlers({ config, confirm, model, usageBus }),
  );
  debug.log("mcp", debugMcpLine(mcpConfigForRun, mcp.specs.length));
  let created: ReturnType<typeof createCliAgent>;
  try {
    const subagents = withInlineAgents(loadAgentDefinitions(projectPath, mcp.pluginContributions), inlineAgents);
    if (inlineAgents.length > 0) {
      debug.log("subagent", `inline agents: ${inlineAgents.map((agent) => agent.id).join(", ")}`);
    }
    created = createCliAgent({
      config,
      workspace: projectPath,
      pluginContributions: mcp.pluginContributions,
      model,
      mcpToolSpecs: mcp.specs,
      confirm,
      usageBus,
      onModelDelta: emitPartial ?? renderer?.modelDelta,
      onReasoningDelta: renderer?.reasoningDelta,
      extractMemory: mode === "edit",
      subagents,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(permissionRules ? { permissionRules } : {}),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
    });
  } catch (error) {
    mcp.dispose();
    throw error;
  }
  const { agent, dispose } = created;
  process.on("SIGINT", onSigint);

  // @-references resolve against the workspace first, then any extra dirs.
  const expand = (t: string): string => expandExtraFileRefs(expandFileRefs(t, projectPath), extraDirs);

  let finalReport: FinalReport | undefined;
  // Run accounting for the result envelope (json + stream-json final line).
  const startedAt = Date.now();
  let numTurns = 0; // assistant text turns observed across runOnce calls
  let outcome: ResultOutcome = { kind: "success" };
  let structuredOutput: unknown;
  let structuredUsage: TokenUsage | undefined;
  // --session-id names the session the FIRST run creates; later runs resume it.
  let pendingSessionId = sessionPlan.newSessionId;

  const runOnce = async (input: {
    task: string;
    mode: "ask" | "edit";
    plan?: boolean;
    resumeSessionId?: string;
  }): Promise<{ sessionId?: string; completed: boolean }> => {
    let sessionId: string | undefined;
    let completed = false;
    const newSessionId = input.resumeSessionId === undefined ? pendingSessionId : undefined;
    pendingSessionId = undefined;
    for await (const event of agent.runTask({
      projectPath,
      task: input.task,
      mode: input.mode,
      plan: input.plan,
      approvalMode,
      resumeSessionId: input.resumeSessionId,
      ...(newSessionId !== undefined ? { sessionId: newSessionId } : {}),
      signal: controller.signal,
      ...(prompts.systemPrompt !== undefined ? { systemPromptOverride: prompts.systemPrompt } : {}),
      ...(effectiveAppend !== undefined ? { appendSystemPrompt: effectiveAppend } : {}),
    })) {
      debug.event(event);
      render(event);
      if (event.type === "model.message") numTurns++;
      if (event.type === "session.created") sessionId = event.sessionId;
      // Prefer aborting mid-run on a usage event; session.completed's report is
      // the backstop when usage is only reported at the end.
      if (event.type === "usage.updated") enforceBudgets(sessionTotals(event));
      if (event.type === "session.completed") {
        completed = true;
        finalReport = event.report;
        enforceBudgets(sessionTotals(event.report));
      }
      if (event.type === "session.failed") {
        outcome = outcomeFromErrorCode(event.error.code, event.error.message);
      }
    }
    return { sessionId, completed };
  };

  // --json-schema: turn the finished run into a value that validates. Returns
  // false (and records the outcome) when it never does.
  const produceStructured = async (taskText: string): Promise<boolean> => {
    if (jsonSchema === undefined || !finalReport) return true;
    // A budget that tripped on the run's last usage report forbids this call too.
    if (controller.signal.aborted) {
      const message = t("err.structuredOutputSkipped");
      outcome = { kind: "structured_output", message };
      fail(message);
      return false;
    }
    debug.log("structured", "requesting structured output");
    try {
      const result = await produceStructuredOutput({
        provider: buildProvider(
          {
            provider: config.provider,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            modelPricing: config.modelPricing,
            thinking: config.thinking,
            reasoningEffort: config.reasoningEffort,
          },
          model,
        ),
        schema: jsonSchema,
        task: taskText,
        result: describeReportForStructuredOutput(finalReport),
        signal: controller.signal,
        onAttempt: (attempt) =>
          debug.log(
            "structured",
            `attempt ${attempt.number}: ${attempt.ok ? "valid" : `invalid — ${attempt.issues.join("; ")}`}`,
          ),
      });
      structuredUsage = result.usage;
      if (result.ok) {
        structuredOutput = result.value;
        return true;
      }
      const message = t("err.structuredOutputFailed", { attempts: result.attempts });
      outcome = { kind: "structured_output", message: `${message}: ${result.issues.join("; ")}` };
      fail(message, { hint: result.issues.join("; ") });
      return false;
    } catch (err) {
      const message = t("err.structuredOutputError", { message: err instanceof Error ? err.message : String(err) });
      outcome = { kind: "structured_output", message };
      fail(message);
      return false;
    }
  };

  // Emits the final Claude-compatible result envelope: pretty-printed for `json`,
  // one JSONL line (via the stream mapper) for `stream-json`. Text mode prints
  // just the structured output, when there is one.
  const emitResult = (sessionId: string | undefined): void => {
    if (opts.suppressResult) return;
    if (format === "text" || format === "stream-json-raw") {
      if (structuredOutput === undefined) return;
      console.log(
        format === "text"
          ? JSON.stringify(structuredOutput, null, 2)
          : JSON.stringify({ type: "structured_output", structured_output: structuredOutput }),
      );
      return;
    }
    const input = {
      ...(finalReport ? { report: finalReport } : {}),
      sessionId,
      numTurns,
      durationMs: Date.now() - startedAt,
      outcome: finalReport ? outcome : outcome.kind === "success" ? { kind: "error" as const } : outcome,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(structuredUsage ? { extraUsage: structuredUsage } : {}),
      ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
    };
    if (format === "stream-json") {
      console.log(JSON.stringify(streamMapper!.result(input)));
    } else {
      console.log(JSON.stringify(buildResultEnvelope(input), null, 2));
    }
  };

  // --max-duration (or config.maxDurationSeconds). Unlike every other cap this
  // is a timer, not a check on the event stream: the runs worth bounding by
  // wall clock are precisely the ones that stopped producing events — a command
  // with no timeout, a silent MCP server, a retry loop. Aborting the same
  // controller Ctrl+C uses keeps the trace and the session.
  //
  // Armed HERE, immediately before the try that clears it, so the two are
  // structurally paired. Setup above (config, workspace consent, MCP spawn,
  // agent construction) is deliberately outside the clock: it can block on a
  // human answering a prompt, and `schedule run` calls this function once per
  // due job in one long-lived process, where a timer left behind by an early
  // return would fire during somebody else's run.
  const deadlineStartedAt = Date.now();
  const deadlineTimer =
    durationBudgetMs === undefined
      ? undefined
      : setTimeout(() => {
          if (controller.signal.aborted) return;
          console.error(
            t("render.durationBudgetReached", {
              budget: String(Math.round(durationBudgetMs / 1_000)),
              elapsed: elapsedSeconds(deadlineStartedAt, Date.now()),
            }),
          );
          controller.abort();
        }, durationBudgetMs);
  // The deadline must never be the reason the process stays alive past its run.
  deadlineTimer?.unref();

  try {
    // --input-format stream-json: read line-delimited user turns from stdin and
    // drive a multi-turn session, chaining each turn onto the prior session id.
    if (opts.inputFormat === "stream-json") {
      let sid = resumeSessionId;
      let turns = 0;
      let lastCompleted = true;
      for await (const turnText of readStreamJsonInput(process.stdin)) {
        turns++;
        // --replay-user-messages: echo the user turn as a stream-json event before
        // processing it (SDK consumers that didn't originate the input can see it).
        if (opts.replayUserMessages && format === "stream-json") {
          console.log(
            JSON.stringify({
              type: "user",
              message: { role: "user", content: [{ type: "text", text: turnText }] },
            }),
          );
        }
        const r = await runOnce({ task: expand(turnText), mode, resumeSessionId: sid });
        sid = r.sessionId ?? sid;
        lastCompleted = r.completed;
        if (!r.completed) break;
      }
      if (turns === 0) {
        fail(t("err.streamJsonNoTurns"));
        return false;
      }
      emitResult(sid);
      if (!lastCompleted) process.exitCode = 1;
      return lastCompleted;
    }

    // Plan mode requires interactive confirmation, so only the human text
    // format supports it (machine formats run straight through).
    if (planMode && !machine) {
      const planTask = expand(task);
      const planRun = await runOnce({ task: planTask, mode: "ask", plan: true, resumeSessionId });
      const planSessionId = planRun.sessionId ?? resumeSessionId;
      if (!planRun.completed || !planSessionId) {
        process.exitCode = 1;
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer: string;
      try {
        answer = (await rl.question(t("render.executeQuestion"))).trim().toLowerCase();
      } finally {
        rl.close();
      }
      if (answer !== "y") {
        console.log(t("render.planKept", { sessionId: planSessionId }));
        return false;
      }
      const execRun = await runOnce({
        task: "Execute the plan you produced above, step by step. Make the changes and run the verification.",
        mode: "edit",
        resumeSessionId: planSessionId,
      });
      const structuredOk = execRun.completed ? await produceStructured(planTask) : true;
      emitResult(execRun.sessionId ?? planSessionId);
      if (!execRun.completed || !structuredOk) process.exitCode = 1;
      return execRun.completed && structuredOk;
    }

    const expandedTask = expand(task);
    const run = await runOnce({ task: expandedTask, mode, resumeSessionId });
    const structuredOk = run.completed ? await produceStructured(expandedTask) : true;
    emitResult(run.sessionId ?? resumeSessionId);
    if (!run.completed || !structuredOk) process.exitCode = 1;
    return run.completed && structuredOk;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
    if (worktree) console.error(formatRunWorktree(worktree));
  }
}
