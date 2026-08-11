import { createInterface } from "node:readline/promises";
import {
  createUsageBus,
  listSessions,
  loadAgentDefinitions,
  readSessionMeta,
  resolvedPricingSource,
} from "@seekforge/core";
import type { AgentEvent, ApprovalMode, FinalReport, TokenUsage } from "@seekforge/shared";
import { cliMcpServerRequestHandlers, createCliAgent, prepareMcp } from "../agent-factory.js";
import { colorIsEnabled, fail } from "../colors.js";
import { loadConfig } from "../config.js";
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
import { extractMcpServersDoc } from "../mcp-config.js";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";
import { resolvePermissionMode, UnknownPermissionModeError } from "../permission-mode.js";
import { confirmInTerminal, createRenderer } from "../render.js";
import { authorizeDir, isAuthorizedDir } from "../authorized-dirs.js";
import { isCostBudgetExceeded } from "../cost-budget.js";
import { elapsedSeconds, resolveDurationBudgetMs } from "../run-deadline.js";
import { resolveOutputStyle } from "../output-style.js";
import { readStreamJsonInput } from "../stream-input.js";
import { buildToolGatingRules, parseToolList } from "../tool-gating.js";
import { expandExtraFileRefs, normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import { apiKeyEnvVar } from "@seekforge/shared/provider-env";

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

/**
 * Runs a headless agent task. Returns `true` iff the agent run COMPLETED
 * successfully (a final report was produced); returns `false` on any guard
 * failure, error, cancellation, or budget cutoff. Callers that gate a
 * side effect on success (e.g. `resolve` committing/pushing) MUST check it —
 * `process.exitCode` alone is not reliable for every early-return path.
 */
export async function runTaskCommand(task: string, opts: RunOptions): Promise<boolean> {
  const projectPath = process.cwd();
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath, opts.settingsFile, opts.profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return false;
  }
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

  // Folder-access consent: SeekForge must be authorized for this directory once
  // (interactively, or via -y) before it reads/edits files here.
  if (!(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine }))) {
    return false;
  }

  // Resolve which session (if any) to resume: explicit --resume wins over -c.
  let resumeSessionId = opts.resumeSessionId;
  if (!resumeSessionId && opts.continueLast) {
    const recent = listSessions(projectPath)[0];
    if (!recent) {
      fail(t("err.noPreviousSession"), { hint: t("err.noPreviousSessionHint") });
      return false;
    }
    resumeSessionId = recent.id;
  }

  let mode = opts.mode;
  if (resumeSessionId) {
    const meta = readSessionMeta(projectPath, resumeSessionId);
    if (!meta) {
      fail(t("err.sessionNotFound", { id: resumeSessionId }), { hint: t("err.sessionNotFoundHint") });
      return false;
    }
    mode = meta.mode; // a resumed session keeps its original ask/edit mode
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

  // --output-style appends a communication-style preset to the system prompt,
  // combined with any explicit --append-system-prompt.
  let styleAddendum: string | undefined;
  if (opts.outputStyle) {
    try {
      styleAddendum = resolveOutputStyle(opts.outputStyle, projectPath);
    } catch {
      fail(t("err.unknownOutputStyle", { style: opts.outputStyle }), {
        hint: t("err.unknownOutputStyleHint"),
      });
      return false;
    }
  }
  const effectiveAppend =
    [styleAddendum, opts.appendSystemPrompt].filter((s): s is string => !!s).join("\n\n") || undefined;

  // --mcp-config: load MCP servers from a JSON file ({mcpServers:{…}} or a bare
  // {name:server} map). --strict-mcp-config uses ONLY those, ignoring the config
  // file's servers; otherwise they merge over the config's (file wins per name).
  let mcpConfigForRun = config;
  if (opts.mcpConfig) {
    let fileServers: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readTextFileBounded(opts.mcpConfig, MAX_CONFIG_FILE_BYTES)) as unknown;
      const extracted = extractMcpServersDoc(parsed);
      if (!extracted) throw new Error("invalid MCP config shape");
      fileServers = extracted;
    } catch {
      fail(t("err.mcpConfigRead", { path: opts.mcpConfig }), { hint: t("err.mcpConfigReadHint") });
      return false;
    }
    const merged = opts.strictMcpConfig ? fileServers : { ...config.mcpServers, ...fileServers };
    mcpConfigForRun = { ...config, mcpServers: merged as typeof config.mcpServers };
  } else if (opts.strictMcpConfig) {
    // strict with no --mcp-config means: no MCP servers at all.
    mcpConfigForRun = { ...config, mcpServers: {} };
  }
  // --allowedTools/--disallowedTools synthesize per-run permission rules,
  // prepended to any config rules. undefined when neither flag is used.
  const permissionRules = buildToolGatingRules({
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    base: config.permissionRules,
  });
  const allowedTools = parseToolList(opts.allowedTools);

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
  let created: ReturnType<typeof createCliAgent>;
  try {
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
      subagents: loadAgentDefinitions(projectPath, mcp.pluginContributions),
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

  // Emits the final Claude-compatible result envelope: pretty-printed for `json`,
  // one JSONL line (via the stream mapper) for `stream-json`. No-op otherwise.
  const emitResult = (sessionId: string | undefined): void => {
    if (opts.suppressResult) return;
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
      const planRun = await runOnce({ task: expand(task), mode: "ask", plan: true });
      if (!planRun.completed || !planRun.sessionId) {
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
        console.log(t("render.planKept", { sessionId: planRun.sessionId ?? "" }));
        return false;
      }
      const execRun = await runOnce({
        task: "Execute the plan you produced above, step by step. Make the changes and run the verification.",
        mode: "edit",
        resumeSessionId: planRun.sessionId,
      });
      if (!execRun.completed) process.exitCode = 1;
      return execRun.completed;
    }

    const run = await runOnce({ task: expand(task), mode, resumeSessionId });
    emitResult(run.sessionId);
    if (!run.completed) process.exitCode = 1;
    return run.completed;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
  }
}
