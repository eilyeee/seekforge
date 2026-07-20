import { spawn, type ChildProcess } from "node:child_process";

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
const MAX_OUTPUT_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 1500;
const FORCE_KILL_DELAY_MS = 250;

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

function inheritedStatusLineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function processGroupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: { ...inheritedStatusLineEnv(), ...statusLineEnv(input) },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let output = Buffer.alloc(0);
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(value);
    };
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("error", () => {});
        } else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminate = (): void => {
      try {
        killGroup("SIGTERM");
      } catch {
        // Status-line failures are deliberately non-fatal to the TUI.
      }
      child.stdout?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killGroup("SIGKILL");
        } catch {
          // Best-effort escalation after returning the fallback status line.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish(null);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
        terminate();
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const groupAlive = processGroupAlive(child);
      if (forceKillTimer !== undefined && !groupAlive) clearTimeout(forceKillTimer);
      if (forceKillTimer === undefined && groupAlive) {
        try {
          killGroup("SIGTERM");
        } catch {
          // Preserve the status-line result while cleaning up descendants.
        }
        forceKillTimer = setTimeout(() => {
          try {
            killGroup("SIGKILL");
          } catch {
            // Best-effort cleanup after the shell has closed.
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
      if (settled || code !== 0) return finish(null);
      const first = output.toString("utf8").split("\n")[0]?.trim() ?? "";
      if (first === "") return finish(null);
      finish(first.length > MAX_LINE_CHARS ? first.slice(0, MAX_LINE_CHARS) : first);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
    const timeoutTimer = setTimeout(terminate, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
}
