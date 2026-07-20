import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { onAbortOnce } from "../util/abort.js";
import { isRecord } from "../util/guards.js";
import { installProcessTeardown } from "../util/process-teardown.js";
import { scrubSecretEnv } from "../util/scrub-env.js";

/** Error thrown for runtime-reported failures; code mirrors PROTOCOL.md. */
export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export type RuntimeClientOptions = {
  /** Path to the seekforge-runtime binary. */
  binPath: string;
  /** Default per-request timeout. Individual calls may override. */
  requestTimeoutMs?: number;
  /**
   * Called when the runtime child exits UNEXPECTEDLY (crash/panic), including
   * when it dies with no in-flight requests. Lets a caller with a structured
   * logger/metrics record the restart; `stderr` is a bounded tail of the
   * child's stderr (its panic/stack trace), empty if it wrote none.
   */
  onExit?: (info: { detail: string; stderr: string }) => void;
};

export type RuntimeClient = {
  call<T>(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  ping(): Promise<{ version: string }>;
  dispose(): void;
};

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** Detaches the abort listener; installed right after the entry is registered. */
  offAbort?: () => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DISPOSE_GRACE_MS = 5_000;
/** After SIGTERM at dispose, wait this long before escalating to SIGKILL. */
const DISPOSE_KILL_GRACE_MS = 2_000;
/** Bounded tail of the runtime's stderr kept for crash diagnostics. */
const STDERR_TAIL_MAX = 4_000;
export const MAX_RUNTIME_RESPONSE_LINE_CHARS = 1_000_000;

/**
 * Line-delimited JSON client for seekforge-runtime (crates/runtime/PROTOCOL.md).
 * The child process is spawned lazily and respawned after a crash; pending
 * requests of a crashed process are rejected with code "runtime_crashed".
 */
export function createRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  const defaultTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending = new Map<string, Pending>();
  let nextId = 1;
  let disposed = false;
  let teardownInstalled = false;
  let removeTeardown: (() => void) | undefined;

  function takePending(id: string): Pending | undefined {
    const request = pending.get(id);
    if (!request) return undefined;
    pending.delete(id);
    clearTimeout(request.timer);
    request.offAbort?.();
    return request;
  }

  function sendCancellation(proc: ChildProcessWithoutNullStreams, id: string): void {
    if (!proc.stdin.writable || proc.stdin.destroyed) return;
    proc.stdin.write(`${JSON.stringify({ method: "cancel", params: { id } })}\n`, () => {});
  }

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child) return child;
    if (disposed) throw new RuntimeError("disposed", "runtime client is disposed");

    // Scrub secrets from the runtime child's env: it never calls the provider
    // API, but it spawns /bin/sh for run_command, which would otherwise inherit
    // (and could exfiltrate) the API key / tokens. Scrubbing here covers the
    // runtime's shells transitively.
    const proc = spawn(options.binPath, [], { stdio: ["pipe", "pipe", "pipe"], env: scrubSecretEnv() });
    child = proc;

    // Drain stderr unconditionally: nothing else reads fd 2, so a runtime that
    // writes a stack trace / panic / verbose log (~64KB) would otherwise fill
    // the pipe buffer and block forever on its own stderr write, hanging every
    // subsequent call() to its timeout. Keep a bounded tail for diagnostics.
    let stderrTail = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX);
    });
    proc.stderr.on("error", () => {});

    // Force-kill the child if the host process dies without calling dispose()
    // (a bare SIGTERM/hard exit would otherwise orphan the runtime), matching
    // the LSP client and browser tool. Installed once, lazily after the first
    // spawn, so sessions that never use the runtime add no listeners.
    if (!teardownInstalled) {
      teardownInstalled = true;
      removeTeardown = installProcessTeardown({
        onSignal: () => dispose(),
        onExit: () => {
          try {
            child?.kill("SIGKILL");
          } catch {
            // best-effort: the child may already be gone
          }
        },
      });
    }

    const handleResponseLine = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return; // not protocol output; ignore
      }
      if (!isRecord(parsed) || parsed["id"] === null) return;
      const id = parsed["id"];
      if (typeof id !== "string" || typeof parsed["ok"] !== "boolean") return;
      const p = pending.get(id);
      if (!p) return;
      takePending(id);
      if (parsed["ok"]) {
        p.resolve(parsed["data"]);
      } else {
        const error = isRecord(parsed["error"]) ? parsed["error"] : undefined;
        p.reject(
          new RuntimeError(
            typeof error?.["code"] === "string" ? error["code"] : "runtime_error",
            typeof error?.["message"] === "string" ? error["message"] : "runtime error",
          ),
        );
      }
    };

    let stdoutBuffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        if (newline > MAX_RUNTIME_RESPONSE_LINE_CHARS) {
          proc.kill("SIGKILL");
          return;
        }
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleResponseLine(line);
      }
      if (stdoutBuffer.length > MAX_RUNTIME_RESPONSE_LINE_CHARS) proc.kill("SIGKILL");
    });

    const onGone = (detail: string) => {
      if (child !== proc) return; // an expected dispose already cleared `child`
      child = undefined;
      const stale = pending;
      pending = new Map();
      const tail = stderrTail.trim();
      const suffix = tail ? `${detail}; stderr: ${tail}` : detail;
      // Always leave a trail. onGone only fires on an UNEXPECTED exit (dispose
      // clears `child` first, so this returns early there). If the runtime
      // panics between calls, `pending` is empty and the loop below surfaces
      // nothing — the stderr tail, the only diagnostic of why it died, would
      // vanish. Emit one line so a recurring crash is visible.
      process.stderr.write(`seekforge-runtime exited unexpectedly (${suffix})\n`);
      options.onExit?.({ detail, stderr: tail });
      for (const p of stale.values()) {
        clearTimeout(p.timer);
        p.offAbort?.();
        p.reject(new RuntimeError("runtime_crashed", `seekforge-runtime exited unexpectedly (${suffix})`));
      }
    };
    proc.on("exit", (code, signal) => onGone(`code=${code} signal=${signal}`));
    proc.on("error", (err) => onGone(err.message));

    return proc;
  }

  function dispose(): void {
    disposed = true;
    removeTeardown?.();
    removeTeardown = undefined;
    teardownInstalled = false;
    const proc = child;
    if (proc) {
      for (const id of pending.keys()) sendCancellation(proc, id);
    }
    for (const id of [...pending.keys()]) {
      takePending(id)?.reject(new RuntimeError("disposed", "runtime client disposed"));
    }
    if (proc) {
      child = undefined;
      proc.stdin.end();
      // Give a freshly spawned runtime enough time to consume the queued
      // request and cancellation before forcing it down under heavy load, then
      // escalate SIGTERM → SIGKILL so a runtime that ignores stdin-EOF and
      // SIGTERM is still reaped instead of lingering.
      let killed = false;
      proc.once("exit", () => {
        killed = true;
      });
      const sigterm = setTimeout(() => {
        if (killed) return;
        try {
          proc.kill("SIGTERM");
        } catch {
          // best-effort
        }
        const sigkill = setTimeout(() => {
          if (killed) return;
          try {
            proc.kill("SIGKILL");
          } catch {
            // best-effort
          }
        }, DISPOSE_KILL_GRACE_MS);
        sigkill.unref();
      }, DISPOSE_GRACE_MS);
      sigterm.unref();
    }
  }

  return {
    call<T>(
      method: string,
      params: Record<string, unknown>,
      opts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<T> {
      if (opts?.signal?.aborted) {
        return Promise.reject(new RuntimeError("cancelled", `runtime request ${method} cancelled`));
      }
      const proc = ensureChild();
      const id = `r${nextId++}`;
      const timeoutMs = opts?.timeoutMs ?? defaultTimeout;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const request = takePending(id);
          if (!request) return;
          sendCancellation(proc, id);
          request.reject(new RuntimeError("runtime_timeout", `runtime did not answer ${method} within ${timeoutMs}ms`));
        }, timeoutMs);
        const entry: Pending = { resolve: resolve as (d: unknown) => void, reject, timer };
        pending.set(id, entry);
        entry.offAbort = onAbortOnce(opts?.signal, () => {
          const request = takePending(id);
          if (!request) return;
          sendCancellation(proc, id);
          request.reject(new RuntimeError("cancelled", `runtime request ${method} cancelled`));
        });
        // An already-aborted signal fired synchronously above: rejected, entry
        // taken — do not write the request at all.
        if (opts?.signal?.aborted) return;
        proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
          if (err) {
            const request = takePending(id);
            request?.reject(new RuntimeError("runtime_write_failed", err.message));
          }
        });
      });
    },

    ping() {
      return this.call<{ version: string }>("ping", {});
    },

    dispose,
  };
}
