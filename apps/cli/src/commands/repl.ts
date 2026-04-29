import { createInterface, type Interface } from "node:readline/promises";
import { addMemoryFact, listSessions, loadAgentDefinitions, readSessionMeta } from "@seekforge/core";
import type { PermissionRequest, TokenUsage } from "@seekforge/shared";
import { createCliAgent, prepareMcp } from "../agent-factory.js";
import { loadConfig } from "../config.js";
import { expandFileRefs } from "../file-refs.js";
import { createRenderer, formatContextSuffix, formatUsage } from "../render.js";

const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const HELP = `
Slash commands:
  /help              show this help
  /new               start a fresh session (next message opens it)
  /sessions          list sessions of this project
  /resume <id>       continue an existing session
  /plan <task>       plan read-only first, confirm, then execute
  /model <name>      switch model (e.g. deepseek-chat, deepseek-v4-flash, deepseek-v4-pro)
  /think [on|off|high|max]  V4 thinking mode and reasoning effort
  /remember <fact>   save a fact to project memory (project.md)
  /usage             cumulative token usage and cost for this REPL
  /context           context-window occupancy of the last turn
  /quit              exit (Ctrl+D also works)
Anything else is sent to the agent. @path tokens inline file contents.
`.trim();

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
    console.log(`\n${YELLOW}Permission required${RESET} [${req.permission}] ${req.toolName}`);
    if (req.command) console.log(`  command: ${req.command}`);
    if (req.path) console.log(`  path:    ${req.path}`);
    if (!req.command && !req.path) console.log(`  ${req.description}`);
    const answer = await rl.question("Allow? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  };
}

/** ask_user channel over the REPL's readline: numbered options, pick by index. */
function makeAskUser(rl: Interface): (q: { question: string; options: string[] }) => Promise<string> {
  return async (q) => {
    console.log(`\n${YELLOW}Question${RESET} ${q.question}`);
    q.options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    const answer = (await rl.question(`answer [1-${q.options.length}]: `)).trim();
    const n = Number.parseInt(answer, 10);
    if (!Number.isInteger(n) || n < 1 || n > q.options.length) return "(the user declined to answer)";
    return q.options[n - 1] as string;
  };
}

export async function replCommand(opts: { model?: string; yes?: boolean }): Promise<void> {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  if (!config.apiKey) {
    console.error(
      "No DeepSeek API key found. Set DEEPSEEK_API_KEY or run: seekforge config set apiKey <key> --global",
    );
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const mcp = await prepareMcp(config); // MCP servers live for the whole REPL
  let model = opts.model ?? config.model ?? "deepseek-v4-flash";
  let sessionId: string | undefined;
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
  let lastContext: { usedTokens: number; budgetTokens: number; percent: number } | undefined;
  const renderer = createRenderer({ streaming: true });

  console.log(`SeekForge — interactive session  ${DIM}(${model}, ${projectPath})${RESET}`);
  console.log(`${DIM}Type a task, or /help for commands. Ctrl+C cancels a running task.${RESET}\n`);

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
      console.error("\ncancelling…");
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
      line = (await rl.question("seekforge ❯ ")).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (line === "") continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
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
          console.log("next message starts a fresh session");
          break;
        case "/sessions":
          for (const s of listSessions(projectPath).slice(0, 15)) {
            console.log(`${s.id}  [${s.status}]  ${s.task.replace(/\s+/g, " ").slice(0, 60)}`);
          }
          break;
        case "/resume": {
          const id = rest[0];
          if (!id || !readSessionMeta(projectPath, id)) {
            console.log("usage: /resume <session-id> (see /sessions)");
            break;
          }
          sessionId = id;
          console.log(`continuing session ${id} — your next message resumes it`);
          break;
        }
        case "/plan": {
          const planTask = rest.join(" ").trim();
          if (!planTask) {
            console.log("usage: /plan <task>");
            break;
          }
          try {
            await runOnce(planTask, { mode: "ask", plan: true });
            const answer = (await rl.question("\nExecute this plan? [y/N] ")).trim().toLowerCase();
            if (answer === "y") {
              await runOnce(
                "Execute the plan you produced above, step by step. Make the changes and run the verification.",
                { mode: "edit" },
              );
            } else {
              console.log("plan kept; the session continues — refine it or /new");
            }
          } catch (err) {
            console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "/model":
          if (rest[0] === "deepseek-reasoner") {
            console.log("deepseek-reasoner has no tool calling and cannot drive the agent yet");
            break;
          }
          if (!rest[0]) {
            console.log(`model: ${model} (try deepseek-chat, deepseek-v4-flash, deepseek-v4-pro)`);
            break;
          }
          model = rest[0];
          console.log(`model: ${model}`);
          break;
        case "/think": {
          const arg = rest[0];
          if (!arg) {
            console.log(
              `thinking: ${config.thinking === false ? "off" : "on"}${config.reasoningEffort ? ` · effort ${config.reasoningEffort}` : ""} (V4 models only — /think on|off|high|max)`,
            );
            break;
          }
          if (arg === "on") config.thinking = true;
          else if (arg === "off") config.thinking = false;
          else if (arg === "high" || arg === "max") {
            config.thinking = true;
            config.reasoningEffort = arg;
          } else {
            console.log("usage: /think [on|off|high|max]");
            break;
          }
          console.log(
            `thinking ${config.thinking === false ? "off" : "on"}${config.reasoningEffort ? ` · effort ${config.reasoningEffort}` : ""} — applies from the next message` +
              (model.startsWith("deepseek-v4") ? "" : " (needs a deepseek-v4 model: /model)"),
          );
          break;
        }
        case "/remember": {
          const fact = rest.join(" ").trim();
          if (!fact) {
            console.log("usage: /remember <fact>");
            break;
          }
          try {
            const c = addMemoryFact(projectPath, { content: fact, type: "convention" });
            console.log(`remembered → project.md: ${c.content}`);
          } catch (err) {
            console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
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
            console.log(`context: ${k(usedTokens)} of ${k(budgetTokens)} budget tokens used (${percent}%)`);
          } else {
            console.log("context: no turn run yet this REPL");
          }
          console.log(
            `${DIM}When usage exceeds the budget, older turns are compacted into a short digest automatically.${RESET}`,
          );
          break;
        }
        default:
          console.log(`unknown command ${cmd} — /help for the list`);
      }
      continue;
    }

    try {
      await runOnce(line);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  rl.close();
  mcp.dispose();
}
