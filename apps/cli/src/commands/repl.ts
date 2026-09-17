import { createInterface, type Interface } from "node:readline/promises";
import {
  addMemoryFact,
  buildProvider,
  commandHasShellInjection,
  compactSessionNow,
  createMemoryMaintenanceScheduler,
  detectThinkingKeyword,
  expandShellInjections,
  expandUserCommand,
  forkSession,
  formatUserShellContext,
  listSessions,
  llmCompactSessionNow,
  loadAgentDefinitions,
  loadUserCommands,
  MAX_USER_SHELL_RUNS,
  readSessionMeta,
  renameSession,
  createUsageBus,
  withInlineAgents,
  type UserShellRun,
} from "@seekforge/core";
import type { ApprovalMode, ConfirmResult, PermissionRequest, PermissionRule, TokenUsage } from "@seekforge/shared";
import { expandExtraFileRefs, normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import { cliMcpServerRequestHandlers, createCliAgent, prepareMcp } from "../agent-factory.js";
import { buildToolGatingRules, parseToolList } from "../tool-gating.js";
import { dim, fail, yellow } from "../colors.js";
import { loadConfig, type CliConfig } from "../config.js";
import { debugConfigLines, debugMcpLine, ensureWorkspaceAuthorized } from "./run.js";
import { expandFileRefs } from "@seekforge/shared/file-refs";
import { t } from "../i18n.js";
import { apiKeyEnvVar } from "@seekforge/shared/provider-env";
import { formatSessionLine, statusCommand } from "./sessions.js";
import { createRenderer, formatContextSuffix, formatUsage } from "../render.js";
import { parseNumberedChoice } from "../input-selection.js";
import { runShell, runShellCapture } from "../shell-capture.js";
import { runInheritedCommand } from "../inherited-command.js";
import { createDebugLogger } from "../debug-log.js";
import { parsePermissionAnswer, permissionPromptText, sessionGrantable } from "../permission-answer.js";
import { isCostBudgetExceeded } from "../cost-budget.js";
import { resolvePermissionMode, UnknownPermissionModeError } from "../permission-mode.js";
import {
  parseAgentsFlag,
  resolveMcpServers,
  resolvePromptFlags,
  resolveSessionFlags,
  RunSetupError,
} from "../run-setup.js";

const HELP = t("repl.help");

/** Bytes of a `!command`'s output kept for the next message (the terminal shows all of it). */
const MAX_BANG_CAPTURE_BYTES = 256 * 1024;

export type ReplOptions = {
  model?: string;
  yes?: boolean;
  settingsFile?: string;
  profile?: string;
  continueLast?: boolean;
  resumeSessionId?: string;
  forkSession?: boolean;
  sessionId?: string;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  /** Every plain message runs read-only. */
  ask?: boolean;
  addDirs?: string[];
  mcpConfig?: string;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  outputStyle?: string;
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: number;
  fallbackModel?: string;
  verbose?: boolean;
  /** Stop spending once this REPL has cost this much (USD). */
  maxCostUsd?: number;
  agentsJson?: string;
  debug?: boolean | string;
};

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** The question options for the run currently in flight, so Ctrl+C can withdraw a pending prompt. */
type SignalSource = () => AbortSignal | undefined;

type ReadLine = (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

/**
 * One reader for every prompt the REPL shows. readline only hands a line to a
 * PENDING question and emits the rest as "line" events, so piped input that
 * arrives between questions was silently dropped. Those lines are queued —
 * for piped input only: at a terminal, text typed before a permission prompt
 * appeared must never become its answer.
 */
export function createLineReader(rl: Interface, queueUnasked: boolean): ReadLine {
  const queued: string[] = [];
  if (queueUnasked) rl.on("line", (line: string) => queued.push(line));
  return async (prompt, opts = {}) => {
    const next = queued.shift();
    if (next !== undefined) {
      opts.signal?.throwIfAborted();
      // What rl.question prints for a line it receives while pending.
      process.stdout.write(prompt);
      return next;
    }
    return rl.question(prompt, opts);
  };
}

function questionOptions(currentSignal: SignalSource): { signal?: AbortSignal } {
  const signal = currentSignal();
  return signal ? { signal } : {};
}

/** Permission prompt sharing the REPL's readline (no competing stdin readers). */
function makeConfirm(
  readLine: ReadLine,
  currentSignal: SignalSource,
): (req: PermissionRequest) => Promise<ConfirmResult> {
  return async (req) => {
    console.log(`\n${yellow(t("repl.permissionRequired"))} [${req.permission}] ${req.toolName}`);
    if (req.command) console.log(`  command: ${req.command}`);
    if (req.path) console.log(`  path:    ${req.path}`);
    if (!req.command && !req.path) console.log(`  ${req.description}`);
    const answer = await readLine(permissionPromptText(req), questionOptions(currentSignal));
    return parsePermissionAnswer(answer, { sessionGrantable: sessionGrantable(req) });
  };
}

/** ask_user channel over the REPL's readline: numbered options, pick by index. */
function makeAskUser(
  readLine: ReadLine,
  currentSignal: SignalSource,
): (q: { question: string; options: string[]; freeText?: boolean }) => Promise<string> {
  return async (q) => {
    console.log(`\n${yellow(t("repl.question"))} ${q.question}`);
    q.options.forEach((opt, i) => {
      console.log(`  ${i + 1}. ${opt}`);
    });
    const prompt = q.freeText
      ? t("repl.answerPromptFreeText", { max: q.options.length })
      : t("repl.answerPrompt", { max: q.options.length });
    const answer = (await readLine(prompt, questionOptions(currentSignal))).trim();
    const selected = parseNumberedChoice(answer, q.options.length);
    if (selected !== null) return q.options[selected] as string;
    // A typed answer is the point of freeText; only an empty line declines.
    if (q.freeText && answer !== "") return answer;
    return t("repl.userDeclined");
  };
}

/** `task` plus the block describing the user's own `!` commands, when there are any. */
export function withUserShellContext(task: string, runs: UserShellRun[]): string {
  const context = formatUserShellContext(runs);
  return context ? `${task}\n\n${context}` : task;
}

/** A ChatProvider-shaped summarizer built exactly as the agent's own provider is. */
function summaryProvider(config: CliConfig, model: string) {
  return buildProvider(
    {
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelPricing: config.modelPricing,
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    model,
  );
}

function reportSetupError(err: unknown): boolean {
  if (err instanceof RunSetupError) {
    fail(err.message, err.hint ? { hint: err.hint } : undefined);
    return true;
  }
  if (err instanceof UnknownPermissionModeError) {
    fail(t("err.unknownPermissionMode", { mode: err.mode }), { hint: t("err.unknownPermissionModeHint") });
    return true;
  }
  return false;
}

export async function replCommand(opts: ReplOptions): Promise<void> {
  const projectPath = process.cwd();
  const debug = createDebugLogger(opts.debug);
  // Custom slash commands from .seekforge/commands/*.md (project + user).
  const userCommands = loadUserCommands(projectPath);
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath, opts.settingsFile, opts.profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return;
  }
  for (const line of debugConfigLines(config, opts)) debug.log("config", line);
  if (!config.apiKey) {
    fail(t("err.noApiKey"), {
      hint: t("err.noApiKeyHint", { keyEnv: apiKeyEnvVar(config.provider) }),
    });
    return;
  }
  let model = opts.model ?? config.model ?? "deepseek-v4-flash";
  if (model === "deepseek-reasoner") {
    fail(t("err.reasonerNoToolCall"), { hint: t("err.reasonerHint") });
    return;
  }

  // Validate every flag before the first effect (consent, fork, MCP spawn).
  let approvalMode: ApprovalMode;
  let planFromMode: boolean;
  let prompts: ReturnType<typeof resolvePromptFlags>;
  let inlineAgents: ReturnType<typeof parseAgentsFlag>;
  let sessionPlan: ReturnType<typeof resolveSessionFlags>;
  let mcpConfig: CliConfig;
  try {
    ({ approvalMode, planFromMode } = resolvePermissionMode({
      yes: opts.yes,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      permissionMode: opts.permissionMode,
    }));
    prompts = resolvePromptFlags(opts, projectPath);
    inlineAgents = parseAgentsFlag(opts.agentsJson);
    sessionPlan = resolveSessionFlags(projectPath, opts);
    mcpConfig = resolveMcpServers(config, opts);
  } catch (err) {
    if (reportSetupError(err)) return;
    throw err;
  }
  const sessionRules = buildToolGatingRules({
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    base: config.permissionRules,
  });
  const sessionAllowedTools = parseToolList(opts.allowedTools);
  const extraDirs: string[] = [];
  for (const raw of opts.addDirs ?? []) {
    const abs = normalizeExtraDir(raw, projectPath);
    if (abs) extraDirs.push(abs);
    else console.error(t("err.excludedDirSkipped", { dir: raw }));
  }
  const costBudgetUsd = opts.maxCostUsd;

  // Folder-access consent: authorize this directory once before the session.
  if (!(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine: false }))) {
    return;
  }

  let sessionId = sessionPlan.resumeSessionId;
  if (sessionPlan.fork && sessionId !== undefined) {
    let forked: string | null;
    try {
      forked = forkSession(projectPath, sessionId);
    } catch (err) {
      fail(t("err.forkFailed", { id: sessionId }), { hint: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!forked) {
      fail(t("err.forkFailed", { id: sessionId }), { hint: t("err.sessionNotFoundHint") });
      return;
    }
    console.log(dim(t("render.forkedSession", { from: sessionId, id: forked })));
    sessionId = forked;
  }
  // --session-id names the session the first message creates.
  let pendingSessionId = sessionPlan.newSessionId;
  const baseMode: "ask" | "edit" = opts.ask ? "ask" : "edit";
  let sessionMode: "ask" | "edit" = opts.ask ? "ask" : (sessionPlan.resumeMode ?? "edit");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // The signal of whatever is running (an agent turn or a `!` command). Ctrl+C
  // at a terminal reaches readline as its own SIGINT event — the process never
  // sees a signal while readline holds raw mode — and with no listener readline
  // closes itself, which ended the REPL instead of cancelling the run.
  let active: AbortController | undefined;
  const currentSignal: SignalSource = () => active?.signal;
  const cancelActive = (): void => {
    if (!active || active.signal.aborted) return;
    console.error(t("render.cancellingRepl"));
    active.abort();
  };
  const withCancellation = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    active = controller;
    rl.on("SIGINT", cancelActive);
    process.on("SIGINT", cancelActive);
    try {
      return await run(controller.signal);
    } finally {
      rl.removeListener("SIGINT", cancelActive);
      process.removeListener("SIGINT", cancelActive);
      if (active === controller) active = undefined;
    }
  };

  const readLine = createLineReader(rl, process.stdin.isTTY !== true);
  const confirm = makeConfirm(readLine, currentSignal);
  const askUser = makeAskUser(readLine, currentSignal);
  // MCP servers live for the whole REPL. The REPL has a terminal to prompt on,
  // so a server may ask for a model call or an answer — both go through the
  // same readline channels the agent itself uses.
  const usageBus = createUsageBus();
  const mcp = await prepareMcp(
    mcpConfig,
    projectPath,
    cliMcpServerRequestHandlers({
      config,
      confirm,
      askUser,
      usageBus,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }),
  );
  debug.log("mcp", debugMcpLine(mcpConfig, mcp.specs.length));
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
  let lastContext: { usedTokens: number; budgetTokens: number; percent: number } | undefined;
  let budgetExhausted = false;
  // The user's own `!` commands since the last message, carried into the next one.
  let shellRuns: UserShellRun[] = [];
  const renderer = createRenderer({ streaming: true, verbose: opts.verbose });
  const memoryMaintenanceScheduler =
    config.memoryMaintenance?.enabled === true
      ? createMemoryMaintenanceScheduler({
          targets: () => [{ workspace: projectPath, getConfig: () => config.memoryMaintenance }],
        })
      : undefined;

  console.log(`${t("repl.welcome", { model, path: projectPath })}`);
  if (sessionId) console.log(dim(t("repl.continuingSession", { id: sessionId })));
  if (pendingSessionId) console.log(dim(t("repl.sessionStartId", { id: pendingSessionId })));
  console.log(`${dim(t("repl.welcomeHint"))}\n`);

  const budgetReached = (spent: number): boolean => isCostBudgetExceeded(spent, costBudgetUsd);

  const runOnce = async (
    task: string,
    runOpts?: {
      mode?: "ask" | "edit";
      plan?: boolean;
      model?: string;
      permissionRules?: PermissionRule[];
      allowedTools?: string[];
    },
  ): Promise<boolean> => {
    if (budgetExhausted) {
      console.log(t("repl.budgetReached", { budget: (costBudgetUsd ?? 0).toFixed(4) }));
      return false;
    }
    // Inline thinking triggers ("think hard" / "ultrathink") raise the effort
    // for this turn only, without mutating the persistent /think setting.
    const effort = detectThinkingKeyword(task);
    const baseRunConfig = effort ? { ...config, thinking: true, reasoningEffort: effort } : config;
    // The REPL owns an idle scheduler, so its Agent must not compact in the
    // foreground at session completion.
    const runConfig = { ...baseRunConfig, memoryMaintenance: undefined };
    const permissionRules = runOpts?.permissionRules ?? sessionRules;
    const allowedTools = runOpts?.allowedTools ?? (sessionAllowedTools.length > 0 ? sessionAllowedTools : undefined);
    const { agent, dispose } = createCliAgent({
      config: runConfig,
      workspace: projectPath,
      pluginContributions: mcp.pluginContributions,
      model: runOpts?.model ?? model,
      ...(permissionRules ? { permissionRules } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
      confirm,
      usageBus,
      onModelDelta: renderer.modelDelta,
      onReasoningDelta: renderer.reasoningDelta,
      askUser,
      extractMemory: true,
      subagents: withInlineAgents(loadAgentDefinitions(projectPath, mcp.pluginContributions), inlineAgents),
      mcpToolSpecs: mcp.specs,
    });
    const carried = shellRuns;
    shellRuns = [];
    const newSessionId = sessionId === undefined ? pendingSessionId : undefined;
    let completed = false;
    let started = false;
    try {
      await withCancellation(async (signal) => {
        const controller = active;
        for await (const event of agent.runTask({
          projectPath,
          task: withUserShellContext(expandExtraFileRefs(expandFileRefs(task, projectPath), extraDirs), carried),
          mode: runOpts?.mode ?? sessionMode,
          plan: runOpts?.plan,
          approvalMode,
          resumeSessionId: sessionId,
          ...(newSessionId !== undefined ? { sessionId: newSessionId } : {}),
          signal,
          ...(prompts.systemPrompt !== undefined ? { systemPromptOverride: prompts.systemPrompt } : {}),
          ...(prompts.appendSystemPrompt !== undefined ? { appendSystemPrompt: prompts.appendSystemPrompt } : {}),
        })) {
          debug.event(event);
          if (event.type === "session.created") {
            started = true;
            sessionId = event.sessionId;
            pendingSessionId = undefined;
          }
          if (
            event.type === "usage.updated" &&
            !budgetExhausted &&
            budgetReached(totalUsage.costUsd + event.usage.costUsd)
          ) {
            budgetExhausted = true;
            console.error(t("render.costBudgetReached", { budget: (costBudgetUsd ?? 0).toFixed(4) }));
            controller?.abort();
          }
          if (event.type === "session.completed") {
            completed = true;
            totalUsage = addUsage(totalUsage, event.report.usage);
            if (budgetReached(totalUsage.costUsd)) budgetExhausted = true;
          }
          if (event.type === "context.usage") {
            lastContext = {
              usedTokens: event.usedTokens,
              budgetTokens: event.budgetTokens,
              percent: event.percent,
            };
          }
          renderer.render(event);
        }
      });
    } finally {
      dispose();
      // A turn that never reached the session (busy, refused) delivered nothing.
      if (!started) shellRuns = [...carried, ...shellRuns].slice(-MAX_USER_SHELL_RUNS);
    }
    return completed;
  };

  /** `/plan`, and every message under `--permission-mode plan`: plan read-only, confirm, execute. */
  const planThenExecute = async (planTask: string): Promise<void> => {
    if (!(await runOnce(planTask, { mode: "ask", plan: true }))) return;
    // --ask promised a read-only session; executing would break that promise.
    if (opts.ask) return;
    const answer = (await readLine(t("repl.executeQuestion"))).trim().toLowerCase();
    if (answer === "y") {
      await runOnce("Execute the plan you produced above, step by step. Make the changes and run the verification.", {
        mode: "edit",
      });
    } else {
      console.log(t("repl.planKept"));
    }
  };

  const runBang = async (command: string): Promise<void> => {
    const result = await withCancellation((signal) =>
      runShell(command, projectPath, {
        maxBytes: MAX_BANG_CAPTURE_BYTES,
        overflow: "tail",
        onOutput: (chunk) => process.stdout.write(chunk),
        signal,
      }),
    );
    const exitCode = result.exitCode ?? 1;
    const note = result.failure ?? (result.signal ? `signal ${result.signal}` : `exit ${exitCode}`);
    if (result.output !== "" && !result.output.endsWith("\n")) process.stdout.write("\n");
    console.log(dim(`${note} · ${t("repl.shellQueued")}`));
    shellRuns = [
      ...shellRuns,
      { command, output: result.failure ? `${result.output}\n[${result.failure}]` : result.output, exitCode },
    ].slice(-MAX_USER_SHELL_RUNS);
    debug.log("command", `!${command} -> ${note}`);
  };

  const compact = async (focus: string): Promise<void> => {
    if (!sessionId) {
      console.log(t("repl.noActiveSession"));
      return;
    }
    const target = sessionId;
    if (focus === "") {
      const result = compactSessionNow(projectPath, target);
      if (!result) console.log(t("repl.sessionTooShort"));
      else
        console.log(
          t("repl.compacted", { dropped: result.droppedTurns, before: result.beforeTokens, after: result.afterTokens }),
        );
      return;
    }
    // A focus steers a model-written summary; the mechanical digest has no
    // way to follow one.
    console.log(dim(t("repl.compactingFocus", { focus })));
    const summary = await llmCompactSessionNow(projectPath, target, summaryProvider(config, model), focus);
    if (summary) {
      if (summary.usage) totalUsage = addUsage(totalUsage, summary.usage);
      console.log(
        t("repl.compactedLlm", {
          dropped: summary.droppedTurns,
          before: summary.beforeTokens,
          after: summary.afterTokens,
        }),
      );
      return;
    }
    // null: too short, or the model call failed. The mechanical pass tells which.
    const fallback = compactSessionNow(projectPath, target);
    if (!fallback) {
      console.log(t("repl.sessionTooShort"));
      return;
    }
    console.log(dim(t("repl.compactFallback")));
    console.log(
      t("repl.compacted", {
        dropped: fallback.droppedTurns,
        before: fallback.beforeTokens,
        after: fallback.afterTokens,
      }),
    );
  };

  try {
    for (;;) {
      let line: string;
      try {
        line = (await readLine(t("repl.prompt"))).trim();
      } catch {
        break; // Ctrl+D / closed stdin
      }
      if (line === "") continue;

      // "!cmd" runs the user's own command in the workspace, like a terminal.
      if (line.startsWith("!")) {
        const command = line.slice(1).trim();
        if (!command) {
          console.log(t("repl.shellUsage"));
          continue;
        }
        try {
          await runBang(command);
        } catch (err) {
          console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
        }
        continue;
      }

      // "# fact" is a shortcut to save a fact to project memory (like Claude Code).
      if (line.startsWith("#")) {
        const fact = line.slice(1).trim();
        if (!fact) {
          console.log(t("repl.rememberUsage"));
          continue;
        }
        try {
          const c = addMemoryFact(projectPath, { content: fact, type: "convention" });
          console.log(t("repl.remembered", { content: c.content }));
        } catch (err) {
          console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
        }
        continue;
      }

      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.split(/\s+/);
        const restText = line.slice((cmd ?? "").length).trim();
        // Custom slash commands (.seekforge/commands/<name>.md) take priority over
        // built-ins on a name clash: expand the body with the trailing args
        // ($ARGUMENTS) and run it as a task.
        const customName = (cmd ?? "").replace(/^\//, "");
        const custom = customName ? userCommands.find((c) => c.name === customName) : undefined;
        if (custom) {
          let task = expandUserCommand(custom, rest.join(" ").trim());
          // !`cmd` injections run in the workspace and their output is inlined.
          if (commandHasShellInjection(task)) {
            task = await expandShellInjections(task, (c) => runShellCapture(c, projectPath));
          }
          // Frontmatter model / allowed-tools apply just to this invocation, and
          // only ever narrow what the session's own --allowedTools allows.
          const customTools = custom.allowedTools ? parseToolList(custom.allowedTools) : undefined;
          const allowedTools =
            customTools && sessionAllowedTools.length > 0
              ? customTools.filter((tool) => sessionAllowedTools.includes(tool))
              : customTools;
          const permissionRules = custom.allowedTools
            ? buildToolGatingRules({ allowedTools: custom.allowedTools, base: sessionRules ?? config.permissionRules })
            : undefined;
          try {
            await runOnce(task, {
              ...(custom.model ? { model: custom.model } : {}),
              ...(permissionRules ? { permissionRules } : {}),
              ...(allowedTools ? { allowedTools } : {}),
            });
          } catch (err) {
            console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
          }
          continue;
        }
        switch (cmd) {
          case "/help":
            console.log(HELP);
            break;
          case "/quit":
          case "/exit":
            return;
          case "/new":
            sessionId = undefined;
            sessionMode = baseMode;
            console.log(t("repl.nextMessageFresh"));
            break;
          case "/clear":
            // clear terminal and reset on-screen history
            process.stdout.write("\x1b[2J\x1b[H");
            console.log(`SeekForge — ${dim(t("repl.screenCleared"))}`);
            break;
          case "/diff":
            await runInheritedCommand("git", ["diff"], projectPath);
            break;
          case "/status":
            statusCommand();
            break;
          case "/compact":
            try {
              await compact(restText);
            } catch (err) {
              console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
            }
            break;
          case "/rename": {
            if (!sessionId) {
              console.log(t("repl.renameNoSession"));
              break;
            }
            if (!restText) {
              console.log(t("repl.renameUsage"));
              break;
            }
            try {
              renameSession(projectPath, sessionId, restText);
              console.log(t("repl.renamed", { id: sessionId, title: restText.replace(/\s+/g, " ") }));
            } catch (err) {
              console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
            }
            break;
          }
          case "/sessions":
            for (const s of listSessions(projectPath).slice(0, 15)) {
              console.log(formatSessionLine(projectPath, s, { cost: false }));
            }
            break;
          case "/resume": {
            const id = rest[0];
            const meta = id ? readSessionMeta(projectPath, id) : undefined;
            if (!id || !meta) {
              console.log(t("repl.resumeUsage"));
              break;
            }
            sessionId = id;
            sessionMode = opts.ask ? "ask" : meta.mode;
            console.log(t("repl.continuingSession", { id }));
            break;
          }
          case "/plan": {
            const planTask = rest.join(" ").trim();
            if (!planTask) {
              console.log(t("repl.planUsage"));
              break;
            }
            try {
              await planThenExecute(planTask);
            } catch (err) {
              console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
            }
            break;
          }
          case "/model":
            if (rest[0] === "deepseek-reasoner") {
              console.log(t("repl.reasonerBlocked"));
              break;
            }
            if (!rest[0]) {
              console.log(t("repl.modelCurrent", { model }));
              break;
            }
            model = rest[0];
            console.log(t("repl.modelSet", { model }));
            break;
          case "/think": {
            const arg = rest[0];
            if (!arg) {
              const state = config.thinking === false ? "off" : "on";
              const effortSuffix = config.reasoningEffort ? ` · effort ${config.reasoningEffort}` : "";
              console.log(t("repl.thinkingCurrent", { state, effortSuffix }));
              break;
            }
            if (arg === "on") config.thinking = true;
            else if (arg === "off") {
              config.thinking = false;
              // Clear any effort set by a prior `/think high|max`; otherwise a
              // stale effort leaks into the next run (and a later `/think on`).
              delete (config as { reasoningEffort?: string }).reasoningEffort;
            } else if (arg === "high" || arg === "max") {
              config.thinking = true;
              config.reasoningEffort = arg;
            } else {
              console.log(t("repl.modelUsage"));
              break;
            }
            const state = config.thinking === false ? "off" : "on";
            const effortSuffix = config.reasoningEffort ? ` · effort ${config.reasoningEffort}` : "";
            const modelSuffix = model.startsWith("deepseek-v4") ? "" : " (needs a deepseek-v4 model: /model)";
            console.log(t("repl.thinkingSet", { state, effortSuffix, modelSuffix }));
            break;
          }
          case "/remember": {
            const fact = rest.join(" ").trim();
            if (!fact) {
              console.log(t("repl.rememberUsage"));
              break;
            }
            try {
              const c = addMemoryFact(projectPath, { content: fact, type: "convention" });
              console.log(t("repl.remembered", { content: c.content }));
            } catch (err) {
              console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
            }
            break;
          }
          case "/usage":
            console.log(`${formatUsage(totalUsage)}${formatContextSuffix(lastContext, { always: true })}`);
            break;
          case "/context": {
            if (lastContext) {
              const { usedTokens, budgetTokens, percent } = lastContext;
              const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
              console.log(t("repl.contextInfo", { used: k(usedTokens), budget: k(budgetTokens), percent }));
            } else {
              console.log(t("repl.contextNone"));
            }
            console.log(dim(t("repl.contextAutoCompaction")));
            break;
          }
          default:
            console.log(t("err.unknownCommand", { cmd: cmd ?? "" }));
        }
        continue;
      }

      try {
        if (planFromMode) await planThenExecute(line);
        else await runOnce(line);
      } catch (err) {
        console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
      }
    }
  } finally {
    memoryMaintenanceScheduler?.dispose();
    rl.close();
    mcp.dispose();
  }
}
