import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import {
  addMemoryFact,
  compactSessionNow,
  expandUserCommand,
  listSessions,
  loadAgentDefinitions,
  loadUserCommands,
  readSessionMeta,
} from "@seekforge/core";
import type { PermissionRequest, TokenUsage } from "@seekforge/shared";
import { createCliAgent, prepareMcp } from "../agent-factory.js";
import { dim, fail, yellow } from "../colors.js";
import { loadConfig } from "../config.js";
import { expandFileRefs } from "../file-refs.js";
import { t } from "../i18n.js";
import { statusCommand } from "./sessions.js";
import { createRenderer, formatContextSuffix, formatUsage } from "../render.js";

const HELP = t("repl.help");

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Permission prompt sharing the REPL's readline (no competing stdin readers). */
function makeConfirm(rl: Interface): (req: PermissionRequest) => Promise<boolean> {
  return async (req) => {
    console.log(`\n${yellow(t("repl.permissionRequired"))} [${req.permission}] ${req.toolName}`);
    if (req.command) console.log(`  command: ${req.command}`);
    if (req.path) console.log(`  path:    ${req.path}`);
    if (!req.command && !req.path) console.log(`  ${req.description}`);
    const answer = await rl.question(t("repl.allowPrompt"));
    return answer.trim().toLowerCase() === "y";
  };
}

/** ask_user channel over the REPL's readline: numbered options, pick by index. */
function makeAskUser(rl: Interface): (q: { question: string; options: string[] }) => Promise<string> {
  return async (q) => {
    console.log(`\n${yellow(t("repl.question"))} ${q.question}`);
    q.options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    const answer = (await rl.question(t("repl.answerPrompt", { max: q.options.length }))).trim();
    const n = Number.parseInt(answer, 10);
    if (!Number.isInteger(n) || n < 1 || n > q.options.length) return t("repl.userDeclined");
    return q.options[n - 1] as string;
  };
}

export async function replCommand(opts: { model?: string; yes?: boolean; settingsFile?: string }): Promise<void> {
  const projectPath = process.cwd();
  // Custom slash commands from .seekforge/commands/*.md (project + user).
  const userCommands = loadUserCommands(projectPath);
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath, opts.settingsFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return;
  }
  if (!config.apiKey) {
    fail(t("err.noApiKey"), {
      hint: t("err.noApiKeyHint"),
    });
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const mcp = await prepareMcp(config, projectPath); // MCP servers live for the whole REPL
  let model = opts.model ?? config.model ?? "deepseek-v4-flash";
  let sessionId: string | undefined;
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
  let lastContext: { usedTokens: number; budgetTokens: number; percent: number } | undefined;
  const renderer = createRenderer({ streaming: true });

  console.log(`${t("repl.welcome", { model, path: projectPath })}`);
  console.log(`${dim(t("repl.welcomeHint"))}\n`);

  const runOnce = async (task: string, runOpts?: { mode?: "ask" | "edit"; plan?: boolean }): Promise<void> => {
    const { agent, dispose } = createCliAgent({
      config,
      model,
      confirm: makeConfirm(rl),
      onModelDelta: renderer.modelDelta,
      onReasoningDelta: renderer.reasoningDelta,
      askUser: makeAskUser(rl),
      extractMemory: true,
      subagents: loadAgentDefinitions(projectPath),
      mcpToolSpecs: mcp.specs,
    });
    const controller = new AbortController();
    const onSigint = (): void => {
      console.error(t("render.cancellingRepl"));
      controller.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      for await (const event of agent.runTask({
        projectPath,
        task: expandFileRefs(task, projectPath),
        mode: runOpts?.mode ?? "edit",
        plan: runOpts?.plan,
        approvalMode: opts.yes ? "auto" : "confirm",
        resumeSessionId: sessionId,
        signal: controller.signal,
      })) {
        if (event.type === "session.created") sessionId = event.sessionId;
        if (event.type === "session.completed") totalUsage = addUsage(totalUsage, event.report.usage);
        if (event.type === "context.usage") {
          lastContext = {
            usedTokens: event.usedTokens,
            budgetTokens: event.budgetTokens,
            percent: event.percent,
          };
        }
        renderer.render(event);
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
      dispose();
    }
  };

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(t("repl.prompt"))).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (line === "") continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      // Custom slash commands (.seekforge/commands/<name>.md) take priority over
      // built-ins on a name clash: expand the body with the trailing args
      // ($ARGUMENTS) and run it as a task.
      const customName = (cmd ?? "").replace(/^\//, "");
      const custom = customName ? userCommands.find((c) => c.name === customName) : undefined;
      if (custom) {
        const task = expandUserCommand(custom, rest.join(" ").trim());
        try {
          await runOnce(task);
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
          rl.close();
          mcp.dispose();
          return;
        case "/new":
          sessionId = undefined;
          console.log(t("repl.nextMessageFresh"));
          break;
        case "/clear":
          // clear terminal and reset on-screen history
          process.stdout.write("\x1b[2J\x1b[H");
          console.log(`SeekForge — ${dim(t("repl.screenCleared"))}`);
          break;
        case "/diff":
          spawn("git", ["diff"], { stdio: "inherit" });
          break;
        case "/status":
          statusCommand();
          break;
        case "/compact": {
          if (!sessionId) {
            console.log(t("repl.noActiveSession"));
            break;
          }
          const result = compactSessionNow(projectPath, sessionId);
          if (!result) {
            console.log(t("repl.sessionTooShort"));
          } else {
            console.log(
              t("repl.compacted", { dropped: result.droppedTurns, before: result.beforeTokens, after: result.afterTokens }),
            );
          }
          break;
        }
        case "/sessions":
          for (const s of listSessions(projectPath).slice(0, 15)) {
            console.log(t("cmd.sessions.output", { id: s.id, status: s.status, cost: "", task: s.task.replace(/\s+/g, " ").slice(0, 60) }));
          }
          break;
        case "/resume": {
          const id = rest[0];
          if (!id || !readSessionMeta(projectPath, id)) {
            console.log(t("repl.resumeUsage"));
            break;
          }
          sessionId = id;
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
            await runOnce(planTask, { mode: "ask", plan: true });
            const answer = (await rl.question(t("repl.executeQuestion"))).trim().toLowerCase();
            if (answer === "y") {
              await runOnce(
                "Execute the plan you produced above, step by step. Make the changes and run the verification.",
                { mode: "edit" },
              );
            } else {
              console.log(t("repl.planKept"));
            }
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
          else if (arg === "off") config.thinking = false;
          else if (arg === "high" || arg === "max") {
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
      await runOnce(line);
    } catch (err) {
      console.error(t("repl.error", { message: err instanceof Error ? err.message : String(err) }));
    }
  }
  rl.close();
  mcp.dispose();
}
