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

/** Runs the TUI's explicit `!command` without blocking rendering or leaking descendants. */
export function runShellCommand(command: string, cwd: string, timeoutMs = 60_000): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ output: error instanceof Error ? error.message : String(error), exitCode: 1 });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const finish = (result: ShellCommandResult): void => {
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
      finish({ output: reason, exitCode: 1 });
    };
    const collect = (chunk: Buffer): void => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_SHELL_OUTPUT_BYTES) {
        terminate(`output exceeded ${MAX_SHELL_OUTPUT_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish({ output: error.message, exitCode: 1 }));
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
      const output = Buffer.concat(chunks).toString("utf8").trimEnd();
      finish({
        output: output || (signal ? `terminated by ${signal}` : "(no output)"),
        exitCode: code ?? 1,
      });
    });
    const timeoutTimer = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
  });
}
