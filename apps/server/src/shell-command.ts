import { spawn, type ChildProcess } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 250;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Runs one custom-command shell injection with an owned, bounded process group. */
export function runShellCommand(command: string, cwd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };

    const terminate = (error: Error): void => {
      try {
        killProcessGroup(child, "SIGTERM");
      } catch {
        // The timeout/output-limit error remains the public failure.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killProcessGroup(child, "SIGKILL");
        } catch {
          // Best-effort escalation after the operation has already failed.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish(error);
    };

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error(`shell command output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new Error(
          `shell command failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });

    const timeoutTimer = setTimeout(() => {
      terminate(new Error(`shell command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
