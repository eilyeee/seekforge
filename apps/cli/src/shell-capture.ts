import { spawn, type ChildProcess } from "node:child_process";

export const MAX_SHELL_CAPTURE_BYTES = 1024 * 1024;
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

function processGroupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === "win32") return child.pid !== undefined;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Captures one custom-command shell injection with bounded process ownership. */
export function runShellCapture(command: string, cwd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(`[command failed: ${error instanceof Error ? error.message : String(error)}]`);
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(value);
    };
    const fail = (message: string): void => {
      try {
        killProcessGroup(child, "SIGTERM");
      } catch {
        // Preserve the original timeout/output failure in the expanded command.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killProcessGroup(child, "SIGKILL");
        } catch {
          // Best-effort escalation after the capture already settled.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish(`[command failed: ${message}]`);
    };
    const collect = (chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_SHELL_CAPTURE_BYTES) {
        fail(`output exceeded ${MAX_SHELL_CAPTURE_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish(`[command failed: ${error.message}]`));
    child.once("close", (code, signal) => {
      if (forceKillTimer !== undefined && !processGroupAlive(child)) clearTimeout(forceKillTimer);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) finish(output);
      else
        finish(
          `[command failed: ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}${output ? `: ${output}` : ""}]`,
        );
    });
    const timeoutTimer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
  });
}
