import { spawn, type ChildProcess } from "node:child_process";

export const MAX_SHELL_OUTPUT_BYTES = 4_000_000;
const FORCE_KILL_DELAY_MS = 250;

export type ShellCommandResult = { output: string; exitCode: number };

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      detached: false,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Raw outcome of one captured shell run. `failure` is set when the run was cut short. */
type CapturedRun = { text: string; exitCode: number; signal: NodeJS.Signals | null; failure?: string };

/** Runs the TUI's explicit `!command` without blocking rendering or leaking descendants. */
export async function runShellCommand(command: string, cwd: string, timeoutMs = 60_000): Promise<ShellCommandResult> {
  const run = await runCaptured(command, cwd, timeoutMs, MAX_SHELL_OUTPUT_BYTES);
  if (run.failure !== undefined) return { output: run.failure, exitCode: 1 };
  return {
    output: run.text || (run.signal ? `terminated by ${run.signal}` : "(no output)"),
    exitCode: run.exitCode,
  };
}

/** Output bound for a custom command's shell injection (the REPL and server use the same). */
export const MAX_INJECTION_OUTPUT_BYTES = 1024 * 1024;

/**
 * One shell injection (`` !`command` ``) of a custom slash command: stdout+stderr on
 * success, a rejection naming the exit status otherwise (core renders it as an
 * inline `[command failed: …]` marker). Bounded like the CLI REPL's capture.
 */
export async function captureShellOutput(command: string, cwd: string, timeoutMs = 10_000): Promise<string> {
  const run = await runCaptured(command, cwd, timeoutMs, MAX_INJECTION_OUTPUT_BYTES);
  if (run.failure !== undefined) throw new Error(run.failure);
  if (run.exitCode !== 0 || run.signal) {
    const status = run.signal ? `signal ${run.signal}` : `exit ${run.exitCode}`;
    throw new Error(run.text ? `${status}: ${run.text}` : status);
  }
  return run.text;
}

function runCaptured(command: string, cwd: string, timeoutMs: number, maxBytes: number): Promise<CapturedRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ text: "", exitCode: 1, signal: null, failure: error instanceof Error ? error.message : String(error) });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const finish = (result: CapturedRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };
    const terminate = (reason: string): void => {
      try {
        killTree(child, "SIGTERM");
      } catch {
        // Preserve the original timeout/output error.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killTree(child, "SIGKILL");
        } catch {
          // Best-effort escalation after the UI has been released.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish({ text: "", exitCode: 1, signal: null, failure: reason });
    };
    const collect = (chunk: Buffer): void => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        terminate(`output exceeded ${maxBytes} bytes`);
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish({ text: "", exitCode: 1, signal: null, failure: error.message }));
    child.once("close", (code, signal) => {
      const descendantsAlive = groupAlive(child);
      if (forceKillTimer !== undefined && !descendantsAlive) clearTimeout(forceKillTimer);
      if (forceKillTimer === undefined && descendantsAlive) {
        try {
          killTree(child, "SIGTERM");
        } catch {
          // Preserve the completed command result.
        }
        forceKillTimer = setTimeout(() => {
          try {
            killTree(child, "SIGKILL");
          } catch {
            // Best-effort cleanup after returning the command result.
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
      finish({ text: Buffer.concat(chunks).toString("utf8").trimEnd(), exitCode: code ?? 1, signal });
    });
    const timeoutTimer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
  });
}
