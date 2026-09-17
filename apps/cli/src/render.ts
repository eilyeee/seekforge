import { createInterface } from "node:readline/promises";
import type { AgentEvent, ConfirmResult, PermissionRequest, PlanItem, TokenUsage } from "@seekforge/shared";
import { type Colorizer, colorIsEnabled, makeColorizer } from "./colors.js";
import { t } from "./i18n.js";
import { parseIndexList } from "./input-selection.js";
import { parsePermissionAnswer, permissionPromptText, sessionGrantable } from "./permission-answer.js";

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
  return `${t("render.tokensLabel", { prompt: k(usage.promptTokens), cacheHit: k(usage.cacheHitTokens), completion: k(usage.completionTokens) })}   ${t("render.costLabel", { cost: usage.costUsd.toFixed(4) })}`;
}

/** Checklist lines for an update_plan result; a step in progress shows its activeForm. */
export function formatPlanItems(items: readonly PlanItem[]): string[] {
  return items.map((item) => {
    const box = item.status === "done" ? "☑" : item.status === "in_progress" ? "◐" : "☐";
    const label = item.status === "in_progress" && item.activeForm?.trim() ? item.activeForm.trim() : item.step;
    return `  ${box} ${label}`;
  });
}

/**
 * The lines a terminal permission prompt prints before its question: the tool,
 * then the RAW command/path, else the request's own description — every line
 * of it indented, so a multi-line one (the plan an exit_plan_mode approval
 * carries) reads as one block.
 */
export function formatPermissionRequest(req: PermissionRequest, heading: string): string[] {
  const lines = [`\n${heading} [${req.permission}] ${req.toolName}`];
  if (req.command) lines.push(`  command: ${req.command}`);
  if (req.path) lines.push(`  path:    ${req.path}`);
  if (!req.command && !req.path) {
    for (const line of req.description.split(/\r?\n/)) lines.push(line.trim() === "" ? "" : `  ${line}`);
  }
  return lines;
}

export type RendererOptions = {
  /** When model output is streamed via onModelDelta, don't reprint it. */
  streaming?: boolean;
  /** Print full tool args and tool result data instead of a quiet summary. */
  verbose?: boolean;
  /**
   * Whether to emit ANSI color. Defaults to the process-wide gate (NO_COLOR /
   * non-TTY aware). Pass `false` for machine output modes so the renderer is
   * guaranteed byte-clean even on a TTY.
   */
  color?: boolean;
};

/**
 * Suffix for usage lines: dim "· ctx 42%". Only shown from 50% occupancy up
 * (below that it is noise); `always` forces it (REPL /usage, /context).
 */
export function formatContextSuffix(ctx: { percent: number } | undefined, opts: { always?: boolean } = {}): string {
  if (!ctx || (!opts.always && ctx.percent < 50)) return "";
  const c = makeColorizer(colorIsEnabled());
  return ` ${c.dim(`· ctx ${ctx.percent}%`)}`;
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
  const c = makeColorizer(opts.color ?? colorIsEnabled());
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
      renderEvent(e, opts, c);
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
        process.stdout.write(`${c.dimItalic(t("render.thinkingLabel"))}\n`);
        inThinking = true;
      }
      // Wrap every chunk so interleaved writes can never leak the style.
      process.stdout.write(c.dimItalic(chunk));
    },
  };
}

function renderEvent(e: AgentEvent, opts: RendererOptions, c: Colorizer): void {
  switch (e.type) {
    case "session.created":
      console.log(c.dim(t("render.session", { id: e.sessionId })));
      break;
    case "step.started":
      console.log(c.dim(t("render.step", { title: e.title })));
      break;
    case "notice":
      console.log(e.level === "warn" ? c.yellow(`! ${e.message}`) : c.dim(`• ${e.message}`));
      break;
    case "model.message":
      if (opts.streaming) {
        console.log(""); // content already streamed; close the line
      } else {
        console.log(`\n${e.content}\n`);
      }
      break;
    case "tool.started":
      process.stdout.write(`${c.dim(`→ ${e.toolName} ${summarizeArgs(e.args, opts.verbose)}`)}\n`);
      break;
    case "tool.completed": {
      if (e.toolName === "update_plan" && e.result.ok) {
        const items = (e.result.data as { items?: PlanItem[] })?.items ?? [];
        console.log(c.yellow(t("render.planLabel")));
        for (const line of formatPlanItems(items)) console.log(line);
        break;
      }
      const mark = e.result.ok ? c.green("✓") : c.red("✗");
      const err = e.result.ok ? "" : ` ${c.red(`${e.result.error?.code}: ${e.result.error?.message}`)}`;
      console.log(`${mark} ${e.toolName}${err}`);
      if (opts.verbose && e.result.ok && e.result.data !== undefined) {
        const dump = summarizeResult(e.result.data);
        if (dump.trim()) console.log(c.dim(dump));
      }
      break;
    }
    case "file.changed":
      console.log(`${c.yellow(t("render.changedLabel"))} ${e.path}`);
      break;
    case "command.output":
      // Live run_command output, streamed as it arrives. Dimmed so it reads
      // as background detail; chunks keep their own newlines.
      process.stdout.write(c.dim(e.chunk));
      break;
    case "context.microcompacted":
      console.log(c.dim(t("render.contextMicrocompacted", { count: e.clearedResults })));
      break;
    case "context.compacted":
      console.log(c.dim(t("render.contextCompacted", { count: e.droppedTurns })));
      break;
    case "provider.retry":
      // Transient retry progress: dim stderr so it never pollutes piped stdout.
      console.error(
        c.dim(
          t("render.retrying", {
            attempt: e.attempt,
            maxAttempts: e.maxAttempts,
            delay: (e.delayMs / 1000).toFixed(1),
            reason: e.reason,
          }),
        ),
      );
      break;
    case "session.failed": {
      console.error(c.red(t("render.failedLabel", { code: e.error.code, message: e.error.message })));
      if (e.error.hint) console.error(c.dim(`  → ${e.error.hint}`));
      // Genuine, recoverable failures: point at the exact resume command.
      if (e.error.recoverable && e.error.sessionId) {
        console.error(c.dim(t("render.resumeHint", { sessionId: e.error.sessionId })));
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
export async function confirmInTerminal(req: PermissionRequest): Promise<ConfirmResult> {
  const c = makeColorizer(colorIsEnabled());
  for (const line of formatPermissionRequest(req, c.yellow(t("render.permissionRequired")))) console.log(line);
  // Multi-hunk selection: offer per-hunk choice when the request carries
  // individual hunk previews (apply_patch with >1 edit).
  if (req.hunks && req.hunks.length > 1) {
    console.log(c.dim(`  ${t("render.edits")}:`));
    for (const hunk of req.hunks) {
      console.log(`    [${hunk.index}] ${hunk.preview}`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  ${t("render.applyPrompt")}`).then(resolve, () => resolve("n"));
        rl.once("SIGINT", () => {
          resolve("n");
          process.emit("SIGINT" as never);
        });
      });
      const trimmed = answer.trim().toLowerCase();
      // The prompt advertises "[N]" (skip all) as the default, so a bare Enter
      // must deny — only an explicit y/yes approves every hunk.
      if (trimmed === "y" || trimmed === "yes") return true;
      // Try to parse as comma-separated hunk indices.
      const selected = parseIndexList(
        trimmed,
        req.hunks.map((hunk) => hunk.index),
      );
      if (selected) return { allow: true, selectedHunks: selected };
      // A refusal may carry a reason ("n: keep the old name"). Every other
      // answer skips all hunks, as the prompt's [N] default promises.
      const refusal = parsePermissionAnswer(answer, { sessionGrantable: false });
      return typeof refusal === "object" && !refusal.allow ? refusal : false;
    } finally {
      rl.close();
    }
  }
  // Single-hunk or no-hunk request: y / a (when grantable) / n[: reason].
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(permissionPromptText(req)).then(resolve, () => resolve("n"));
      rl.once("SIGINT", () => {
        resolve("n");
        process.emit("SIGINT" as never);
      });
    });
    return parsePermissionAnswer(answer, { sessionGrantable: sessionGrantable(req) });
  } finally {
    rl.close();
  }
}
