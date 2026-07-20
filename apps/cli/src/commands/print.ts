// `seekforge -p/--print [prompt]` — headless single run: read piped stdin (if
// any), compose the effective prompt, stream to stdout, and exit. Wraps
// runTaskCommand (the same engine as `run`) but adds stdin composition.

import { fail } from "../colors.js";
import { t } from "../i18n.js";
import { resolveOutputFormat, type OutputFormat } from "../output-format.js";
import { composePrompt, readStdin } from "../stdin-prompt.js";
import { runTaskCommand } from "./run.js";

export type PrintCliOptions = {
  yes?: boolean;
  model?: string;
  ask?: boolean;
  maxCost?: number;
  json?: boolean;
  outputFormat?: string;
  continueLast?: boolean;
  resume?: string;
  addDir?: string[];
  maxTurns?: string;
  verbose?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  permissionMode?: string;
  fallbackModel?: string;
  outputStyle?: string;
  settingsFile?: string;
  profile?: string;
  inputFormat?: string;
  dangerouslySkipPermissions?: boolean;
  mcpConfig?: string;
  strictMcpConfig?: boolean;
  replayUserMessages?: boolean;
  includePartialMessages?: boolean;
};

export function parseMaxTurns(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export async function printCommand(inlinePrompt: string | undefined, opts: PrintCliOptions): Promise<void> {
  let format: OutputFormat;
  try {
    format = resolveOutputFormat(opts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  if (opts.inputFormat !== undefined && opts.inputFormat !== "text" && opts.inputFormat !== "stream-json") {
    fail(t("err.inputFormatTextStream", { format: opts.inputFormat }));
    return;
  }
  const streamInput = opts.inputFormat === "stream-json";

  // text input (default): compose a single prompt from inline + piped stdin.
  // stream-json input: stdin is a turn stream consumed by runTaskCommand, so we
  // do not read it here as one prompt (the inline arg, if any, is ignored).
  let prompt = "";
  if (!streamInput) {
    // readStdin() returns "" immediately when stdin is a TTY (nothing piped), so
    // `-p` with no inline prompt and no pipe fails fast here rather than hanging.
    const stdin = await readStdin();
    prompt = composePrompt(inlinePrompt, stdin) ?? "";
    if (!prompt) {
      fail(t("err.noPrompt"), {
        hint: t("err.noPromptHint"),
      });
      return;
    }
  }

  const maxTurns = parseMaxTurns(opts.maxTurns);
  if (maxTurns !== undefined && (Number.isNaN(maxTurns) || maxTurns <= 0)) {
    fail(t("err.maxTurnsPositive"));
    return;
  }

  await runTaskCommand(prompt, {
    mode: opts.ask ? "ask" : "edit",
    yes: opts.yes,
    maxCostUsd: opts.maxCost,
    model: opts.model,
    outputFormat: format,
    continueLast: opts.continueLast,
    resumeSessionId: opts.resume,
    addDirs: opts.addDir,
    maxTurns,
    verbose: opts.verbose,
    systemPrompt: opts.systemPrompt,
    appendSystemPrompt: opts.appendSystemPrompt,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    permissionMode: opts.permissionMode,
    settingsFile: opts.settingsFile,
    profile: opts.profile,
    fallbackModel: opts.fallbackModel,
    outputStyle: opts.outputStyle,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    mcpConfig: opts.mcpConfig,
    strictMcpConfig: opts.strictMcpConfig,
    replayUserMessages: opts.replayUserMessages,
    includePartialMessages: opts.includePartialMessages,
    ...(streamInput ? { inputFormat: "stream-json" } : {}),
  });
}
