// `seekforge -p/--print [prompt]` — headless single run: read piped stdin (if
// any), compose the effective prompt, stream to stdout, and exit. Wraps
// runTaskCommand (the same engine as `run`) but adds stdin composition.

import { fail } from "../colors.js";
import { resolveOutputFormat, type OutputFormat } from "../output-format.js";
import { composePrompt, readStdin } from "../stdin-prompt.js";
import { runTaskCommand } from "./run.js";

export type PrintCliOptions = {
  yes?: boolean;
  model?: string;
  ask?: boolean;
  json?: boolean;
  outputFormat?: string;
  continueLast?: boolean;
  resume?: string;
  addDir?: string[];
  maxTurns?: string;
  verbose?: boolean;
};

export async function printCommand(inlinePrompt: string | undefined, opts: PrintCliOptions): Promise<void> {
  let format: OutputFormat;
  try {
    format = resolveOutputFormat(opts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  // readStdin() returns "" immediately when stdin is a TTY (nothing piped), so
  // `-p` with no inline prompt and no pipe fails fast here rather than hanging.
  const stdin = await readStdin();
  const prompt = composePrompt(inlinePrompt, stdin);
  if (!prompt) {
    fail("no prompt provided", {
      hint: 'pass one inline (seekforge -p "…") or pipe it (cat task.md | seekforge -p)',
    });
    return;
  }

  const maxTurns = opts.maxTurns !== undefined ? Number.parseInt(opts.maxTurns, 10) : undefined;
  if (maxTurns !== undefined && (Number.isNaN(maxTurns) || maxTurns <= 0)) {
    fail("--max-turns must be a positive integer");
    return;
  }

  await runTaskCommand(prompt, {
    mode: opts.ask ? "ask" : "edit",
    yes: opts.yes,
    model: opts.model,
    outputFormat: format,
    continueLast: opts.continueLast,
    resumeSessionId: opts.resume,
    addDirs: opts.addDir,
    maxTurns,
    verbose: opts.verbose,
  });
}
