import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { onAbortOnce } from "../util/abort.js";
import { isRecord } from "../util/guards.js";

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

    const proc = spawn(options.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
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
    });

    const onGone = (detail: string) => {
      if (child !== proc) return;
      child = undefined;
      const stale = pending;
      pending = new Map();
      for (const p of stale.values()) {
        clearTimeout(p.timer);
        p.offAbort?.();
        p.reject(new RuntimeError("runtime_crashed", `seekforge-runtime exited unexpectedly (${detail})`));
      }
    };
    proc.on("exit", (code, signal) => onGone(`code=${code} signal=${signal}`));
    proc.on("error", (err) => onGone(err.message));

    return proc;
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

    dispose() {
      disposed = true;
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
        // request and cancellation before forcing it down under heavy load.
        const forceKill = setTimeout(() => proc.kill(), DISPOSE_GRACE_MS);
        forceKill.unref();
        proc.once("exit", () => clearTimeout(forceKill));
      }
    },
  };
}
