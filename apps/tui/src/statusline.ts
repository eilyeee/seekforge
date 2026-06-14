import { spawnSync } from "node:child_process";

/**
 * User-configurable statusline: `statusLine` in config is a shell command
 * that receives a JSON payload on stdin AND the same fields as environment
 * variables (SEEKFORGE_MODEL, SEEKFORGE_CWD, SEEKFORGE_SESSION_ID,
 * SEEKFORGE_APPROVAL, SEEKFORGE_COST_USD, SEEKFORGE_CONTEXT_PERCENT,
 * SEEKFORGE_TOTAL_TOKENS). It runs via /bin/sh -c with the workspace as cwd.
 * Only the first line of stdout is used, capped at 80 characters; ANSI escapes
 * are allowed through. Failures, timeouts, and empty output yield null so the
 * app falls back to (and continues to render) its default statusline. The
 * custom line is rendered in addition to the built-in StatusBar, on its own
 * line directly below it.
 */
export type StatusLineInput = {
  model: string;
  cwd: string;
  sessionId?: string;
  costUsd: number;
  contextPercent?: number;
  /** Approval mode (confirm | acceptEdits | auto | plan). */
  approval?: string;
  /** Cumulative prompt+completion tokens for the session. */
  totalTokens?: number;
};

const MAX_LINE_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 1500;

/** Maps the structured input onto SEEKFORGE_* env vars for the script. */
function statusLineEnv(input: StatusLineInput): Record<string, string> {
  const env: Record<string, string> = {
    SEEKFORGE_MODEL: input.model,
    SEEKFORGE_CWD: input.cwd,
    SEEKFORGE_COST_USD: String(input.costUsd),
  };
  if (input.sessionId !== undefined) env["SEEKFORGE_SESSION_ID"] = input.sessionId;
  if (input.approval !== undefined) env["SEEKFORGE_APPROVAL"] = input.approval;
  if (input.contextPercent !== undefined) env["SEEKFORGE_CONTEXT_PERCENT"] = String(input.contextPercent);
  if (input.totalTokens !== undefined) env["SEEKFORGE_TOTAL_TOKENS"] = String(input.totalTokens);
  return env;
}

/**
 * Runs `command` via /bin/sh -c (cwd = input.cwd) with the JSON payload on
 * stdin and SEEKFORGE_* env vars set, returning the trimmed first line of
 * stdout (cap 80 chars), or null on non-zero exit, timeout (default 1.5s),
 * or empty output. Never throws.
 */
export function runStatusLine(
  command: string,
  input: StatusLineInput,
  opts?: { timeoutMs?: number },
): string | null {
  try {
    const result = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify(input),
      cwd: input.cwd,
      env: { ...process.env, ...statusLineEnv(input) },
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.error || result.signal || result.status !== 0) return null;
    const first = (result.stdout ?? "").split("\n")[0]?.trim() ?? "";
    if (first === "") return null;
    return first.length > MAX_LINE_CHARS ? first.slice(0, MAX_LINE_CHARS) : first;
  } catch {
    return null;
  }
}
