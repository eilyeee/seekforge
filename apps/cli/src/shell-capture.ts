import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const MAX_SHELL_CAPTURE_BYTES = 1024 * 1024;
const FORCE_KILL_DELAY_MS = 250;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => {});
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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

export type ShellRunResult = {
  /** stdout and stderr interleaved as they arrived (bounded, see `overflow`). */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the command did not run to completion: spawn error, timeout, overflow, cancel. */
  failure?: string;
};

export type ShellRunOptions = {
  /** Kill the command after this long; unset = no limit. */
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * What exceeding `maxBytes` means: "fail" kills the command (a capture whose
   * output is spliced into a prompt must not grow without bound); "tail" keeps
   * running and keeps only the most recent `maxBytes`.
   */
  overflow?: "fail" | "tail";
  /** Live output, decoded per stream so a split UTF-8 sequence never prints broken. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
};

/** Runs one `/bin/sh -c` command in its own process group, which is torn down with it. */
export function runShell(command: string, cwd: string, opts: ShellRunOptions = {}): Promise<ShellRunResult> {
  const maxBytes = opts.maxBytes ?? MAX_SHELL_CAPTURE_BYTES;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ output: "", exitCode: null, signal: null, failure: "cancelled" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        output: "",
        exitCode: null,
        signal: null,
        failure: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };

    const output = (): string => Buffer.concat(chunks).toString("utf8");
    const finish = (result: ShellRunResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (message: string): void => {
      try {
        killProcessGroup(child, "SIGTERM");
      } catch {
        // Preserve the original timeout/output failure in the result.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      forceKillTimer = setTimeout(() => {
        try {
          killProcessGroup(child, "SIGKILL");
        } catch {
          // Best-effort escalation after the run already settled.
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
      finish({ output: output(), exitCode: null, signal: null, failure: message });
    };
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (settled) return;
      opts.onOutput?.(decoders[stream].write(chunk));
      outputBytes += chunk.length;
      chunks.push(chunk);
      if (outputBytes <= maxBytes) return;
      if (opts.overflow !== "tail") {
        fail(`output exceeded ${maxBytes} bytes`);
        return;
      }
      // Drop whole chunks from the front, then trim the first one.
      while (chunks.length > 1 && outputBytes - (chunks[0]?.length ?? 0) >= maxBytes) {
        outputBytes -= chunks.shift()?.length ?? 0;
      }
      const first = chunks[0];
      if (first && outputBytes > maxBytes) {
        chunks[0] = first.subarray(outputBytes - maxBytes);
        outputBytes = maxBytes;
      }
    };
    const onAbort = (): void => fail("cancelled");

    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    child.once("error", (error) => finish({ output: output(), exitCode: null, signal: null, failure: error.message }));
    child.once("close", (code, signal) => {
      const groupAlive = processGroupAlive(child);
      if (forceKillTimer !== undefined && !groupAlive) clearTimeout(forceKillTimer);
      if (forceKillTimer === undefined && groupAlive) {
        try {
          killProcessGroup(child, "SIGTERM");
        } catch {
          // The command result remains valid; cleanup is best-effort.
        }
        forceKillTimer = setTimeout(() => {
          try {
            killProcessGroup(child, "SIGKILL");
          } catch {
            // Best-effort cleanup of descendants after the shell exited.
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
      const tail = decoders.stdout.end() + decoders.stderr.end();
      if (tail) opts.onOutput?.(tail);
      finish({ output: output(), exitCode: code, signal });
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      const timeoutMs = opts.timeoutMs;
      timeoutTimer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
    }
  });
}

/** Captures one custom-command shell injection with bounded process ownership. */
export async function runShellCapture(command: string, cwd: string, timeoutMs = 10_000): Promise<string> {
  const result = await runShell(command, cwd, { timeoutMs, maxBytes: MAX_SHELL_CAPTURE_BYTES });
  if (result.failure !== undefined) return `[command failed: ${result.failure}]`;
  if (result.exitCode === 0) return result.output;
  const status = result.signal ? `signal ${result.signal}` : `exit ${result.exitCode ?? "unknown"}`;
  return `[command failed: ${status}${result.output ? `: ${result.output}` : ""}]`;
}
