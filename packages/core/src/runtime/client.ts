import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeResponse } from "@seekforge/shared";

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
  call<T>(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  ping(): Promise<{ version: string }>;
  dispose(): void;
};

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child) return child;
    if (disposed) throw new RuntimeError("disposed", "runtime client is disposed");

    const proc = spawn(options.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let res: RuntimeResponse;
      try {
        res = JSON.parse(line) as RuntimeResponse;
      } catch {
        return; // not protocol output; ignore
      }
      if (res.id === null) return; // bad_request for an unparseable line we never sent
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) {
        p.resolve(res.data);
      } else {
        p.reject(new RuntimeError(res.error?.code ?? "runtime_error", res.error?.message ?? "runtime error"));
      }
    });

    const onGone = (detail: string) => {
      if (child !== proc) return;
      child = undefined;
      const stale = pending;
      pending = new Map();
      for (const p of stale.values()) {
        clearTimeout(p.timer);
        p.reject(new RuntimeError("runtime_crashed", `seekforge-runtime exited unexpectedly (${detail})`));
      }
    };
    proc.on("exit", (code, signal) => onGone(`code=${code} signal=${signal}`));
    proc.on("error", (err) => onGone(err.message));

    return proc;
  }

  return {
    call<T>(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
      const proc = ensureChild();
      const id = `r${nextId++}`;
      const timeoutMs = opts?.timeoutMs ?? defaultTimeout;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RuntimeError("runtime_timeout", `runtime did not answer ${method} within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
        proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
          if (err) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new RuntimeError("runtime_write_failed", err.message));
          }
        });
      });
    },

    ping() {
      return this.call<{ version: string }>("ping", {});
    },

    dispose() {
      disposed = true;
      if (child) {
        child.kill();
        child = undefined;
      }
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RuntimeError("disposed", "runtime client disposed"));
      }
      pending.clear();
    },
  };
}
