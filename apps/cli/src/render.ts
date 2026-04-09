import { createInterface } from "node:readline/promises";
import type { AgentEvent, PermissionRequest, TokenUsage } from "@seekforge/shared";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function summarizeArgs(args: unknown): string {
  const text = JSON.stringify(args) ?? "";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function formatUsage(usage: TokenUsage): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
  return (
    `Tokens: ${k(usage.promptTokens)} prompt (${k(usage.cacheHitTokens)} cache hit) / ` +
    `${k(usage.completionTokens)} completion   Cost: $${usage.costUsd.toFixed(4)}`
  );
}

export type RendererOptions = {
  /** When model output is streamed via onModelDelta, don't reprint it. */
  streaming?: boolean;
};

/**
 * Suffix for usage lines: dim "· ctx 42%". Only shown from 50% occupancy up
 * (below that it is noise); `always` forces it (REPL /usage, /context).
 */
export function formatContextSuffix(
  ctx: { percent: number } | undefined,
  opts: { always?: boolean } = {},
): string {
  if (!ctx || (!opts.always && ctx.percent < 50)) return "";
  return ` ${DIM}· ctx ${ctx.percent}%${RESET}`;
}

/** Creates a terminal renderer for agent events. */
export function createRenderer(opts: RendererOptions = {}): (e: AgentEvent) => void {
  // context.usage prints no line of its own; the latest value decorates the
  // final usage line (session.completed) once occupancy is worth mentioning.
  let lastContext: { percent: number } | undefined;
  return (e) => {
    if (e.type === "context.usage") {
      lastContext = { percent: e.percent };
      return;
    }
    if (e.type === "session.completed") {
      console.log(`\n${formatUsage(e.report.usage)}${formatContextSuffix(lastContext)}`);
      return;
    }
    renderEvent(e, opts);
  };
}

function renderEvent(e: AgentEvent, opts: RendererOptions): void {
  switch (e.type) {
    case "session.created":
      console.log(`${DIM}session ${e.sessionId}${RESET}`);
      break;
    case "step.started":
      console.log(`${DIM}· ${e.title}${RESET}`);
      break;
    case "model.message":
      if (opts.streaming) {
        console.log(""); // content already streamed; close the line
      } else {
        console.log(`\n${e.content}\n`);
      }
      break;
    case "tool.started":
      process.stdout.write(`${DIM}→ ${e.toolName} ${summarizeArgs(e.args)}${RESET}\n`);
      break;
    case "tool.completed": {
      if (e.toolName === "update_plan" && e.result.ok) {
        const items = (e.result.data as { items?: Array<{ step: string; status: string }> })?.items ?? [];
        console.log(`${YELLOW}Plan${RESET}`);
        for (const item of items) {
          const box = item.status === "done" ? "☑" : item.status === "in_progress" ? "◐" : "☐";
          console.log(`  ${box} ${item.step}`);
        }
        break;
      }
      const mark = e.result.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const err = e.result.ok ? "" : ` ${RED}${e.result.error?.code}: ${e.result.error?.message}${RESET}`;
      console.log(`${mark} ${e.toolName}${err}`);
      break;
    }
    case "file.changed":
      console.log(`${YELLOW}● changed${RESET} ${e.path}`);
      break;
    case "context.compacted":
      console.log(`${DIM}(context compacted: dropped ${e.droppedTurns} earlier messages)${RESET}`);
      break;
    case "session.failed":
      console.error(`${RED}failed: ${e.error.code} — ${e.error.message}${RESET}`);
      break;
    case "session.completed":
      // Reached only when called outside createRenderer (which intercepts
      // session.completed to append the context suffix).
      console.log(`\n${formatUsage(e.report.usage)}`);
      break;
    default:
      break; // usage.updated / step events: silent in Phase 0
  }
}

/**
 * Permission prompt. Always shows the RAW command/path — never only a
 * model paraphrase (prompt-injection defense, see docs 14 §3).
 */
export async function confirmInTerminal(req: PermissionRequest): Promise<boolean> {
  console.log(`\n${YELLOW}Permission required${RESET} [${req.permission}] ${req.toolName}`);
  if (req.command) console.log(`  command: ${req.command}`);
  if (req.path) console.log(`  path:    ${req.path}`);
  if (!req.command && !req.path) console.log(`  ${req.description}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // readline swallows Ctrl+C while a question is pending: treat it as a
    // denial and re-raise so the session's cancel flow still runs.
    const answer = await new Promise<string>((resolve) => {
      rl.question("Allow? [y/N] ").then(resolve, () => resolve("n"));
      rl.once("SIGINT", () => {
        resolve("n");
        process.emit("SIGINT" as never);
      });
    });
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
