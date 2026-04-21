import { spawnSync } from "node:child_process";

/**
 * User-configurable statusline: `statusLine` in config is a shell command
 * that receives a JSON payload on stdin and prints the line to show. Only
 * the first line of stdout is used, capped at 80 characters; ANSI escapes
 * are allowed through. Failures, timeouts, and empty output yield null so
 * the app falls back to its default statusline.
 */
export type StatusLineInput = {
  model: string;
  cwd: string;
  sessionId?: string;
  costUsd: number;
  contextPercent?: number;
};

const MAX_LINE_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Runs `command` via /bin/sh -c with the JSON payload on stdin and returns
 * the trimmed first line of stdout (cap 80 chars), or null on non-zero exit,
 * timeout (default 1.5s), or empty output. Never throws.
 */
export function runStatusLine(
  command: string,
  input: StatusLineInput,
  opts?: { timeoutMs?: number },
): string | null {
  try {
    const result = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify(input),
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
