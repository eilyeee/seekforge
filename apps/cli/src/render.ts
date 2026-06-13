import { createInterface } from "node:readline/promises";
import type { AgentEvent, PermissionRequest, TokenUsage } from "@seekforge/shared";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";

function summarizeArgs(args: unknown, verbose = false): string {
  const text = JSON.stringify(args, null, verbose ? 2 : undefined) ?? "";
  if (verbose) return text;
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Verbose dump of a tool result's data (truncated to keep output sane). */
function summarizeResult(data: unknown): string {
  const text = typeof data === "string" ? data : (JSON.stringify(data, null, 2) ?? "");
  return text.length > 2000 ? `${text.slice(0, 2000)}\n…[truncated]` : text;
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
  /** Print full tool args and tool result data instead of a quiet summary. */
  verbose?: boolean;
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

export type Renderer = {
  render: (e: AgentEvent) => void;
  /** onModelDelta sink: closes a pending thinking block, then writes raw. */
  modelDelta: (chunk: string) => void;
  /** onReasoningDelta sink: dim italic, "✻ thinking" header once per block. */
  reasoningDelta: (chunk: string) => void;
};

/** Creates a terminal renderer for agent events (plus the delta sinks). */
export function createRenderer(opts: RendererOptions = {}): Renderer {
  // context.usage prints no line of its own; the latest value decorates the
  // final usage line (session.completed) once occupancy is worth mentioning.
  let lastContext: { percent: number } | undefined;
  // True while a streamed chain-of-thought block is open (header printed).
  let inThinking = false;
  return {
    render: (e) => {
      if (e.type === "context.usage") {
        lastContext = { percent: e.percent };
        return;
      }
      if (e.type === "model.message") inThinking = false; // next block reprints the header
      if (e.type === "session.completed") {
        console.log(`\n${formatUsage(e.report.usage)}${formatContextSuffix(lastContext)}`);
        return;
      }
      renderEvent(e, opts);
    },
    modelDelta: (chunk) => {
      if (inThinking) {
        process.stdout.write("\n"); // visual break between thinking and answer
        inThinking = false;
      }
      process.stdout.write(chunk);
    },
    reasoningDelta: (chunk) => {
      if (!inThinking) {
        process.stdout.write(`${DIM}${ITALIC}✻ thinking${RESET}\n`);
        inThinking = true;
      }
      // Wrap every chunk so interleaved writes can never leak the style.
      process.stdout.write(`${DIM}${ITALIC}${chunk}${RESET}`);
    },
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
      process.stdout.write(`${DIM}→ ${e.toolName} ${summarizeArgs(e.args, opts.verbose)}${RESET}\n`);
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
      if (opts.verbose && e.result.ok && e.result.data !== undefined) {
        const dump = summarizeResult(e.result.data);
        if (dump.trim()) console.log(`${DIM}${dump}${RESET}`);
      }
      break;
    }
    case "file.changed":
      console.log(`${YELLOW}● changed${RESET} ${e.path}`);
      break;
    case "command.output":
      // Live run_command output, streamed as it arrives. Dimmed so it reads
      // as background detail; chunks keep their own newlines.
      process.stdout.write(`${DIM}${e.chunk}${RESET}`);
      break;
    case "context.microcompacted":
      console.log(`${DIM}context: cleared ${e.clearedResults} old tool outputs${RESET}`);
      break;
    case "context.compacted":
      console.log(`${DIM}(context compacted: dropped ${e.droppedTurns} earlier messages)${RESET}`);
      break;
    case "provider.retry":
      // Transient retry progress: dim stderr so it never pollutes piped stdout.
      console.error(
        `${DIM}⟳ retrying (${e.attempt}/${e.maxAttempts}) in ${(e.delayMs / 1000).toFixed(1)}s — ${e.reason}${RESET}`,
      );
      break;
    case "session.failed": {
      console.error(`${RED}failed: ${e.error.code} — ${e.error.message}${RESET}`);
      if (e.error.hint) console.error(`${DIM}  → ${e.error.hint}${RESET}`);
      // Genuine, recoverable failures: point at the exact resume command.
      if (e.error.recoverable && e.error.sessionId) {
        console.error(
          `${DIM}  → resume with \`seekforge resume ${e.error.sessionId}\` ` +
            `(your file changes and completed steps are preserved; checkpoints intact)${RESET}`,
        );
      }
      break;
    }
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
