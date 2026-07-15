import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ToolError } from "./errors.js";
import { randomBytes } from "node:crypto";
import { buildSandboxSpec, sandboxedShell, type SandboxLevel, type SandboxProfile } from "./os-sandbox.js";

/** Per-stream ring buffer: keep only the LAST N chars of stdout/stderr. */
const RING_BUFFER_CHARS = 100_000;

export type BackgroundTaskStatus = "running" | "exited";

export type BackgroundTaskSnapshot = {
  id: string;
  runId: string;
  command: string;
  status: BackgroundTaskStatus;
  /** Present once the task exited; null when killed (no exit code). */
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  pid?: number;
  attempt: 1;
  costUsd: 0;
  error?: { code: string; message: string };
};

export type BackgroundTaskSummary = {
  id: string;
  runId: string;
  command: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  durationMs: number;
  attempt: 1;
};

export type BackgroundTaskEvent = {
  runId: string;
  taskId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  attempt: 1;
  costUsd: 0;
  error?: { code: string; message: string };
};

/**
 * Per-session manager for long-running background commands (dev servers,
 * watchers). Tasks are spawned detached in their own process group (same
 * pattern as runShellCommand) so kill() can take down the whole tree.
 */
export type BackgroundTasks = {
  /**
   * Spawn a detached background command. With `sandbox` set, the shell is
   * wrapped in the OS sandbox (writes confined to `workspace`, which defaults
   * to `cwd`); throws ToolError("sandbox_unavailable") rather than silently
   * running unsandboxed when the wrapper cannot be built.
   */
  start(input: {
    command: string;
    cwd: string;
    sandbox?: SandboxLevel | SandboxProfile | undefined;
    workspace?: string | undefined;
  }): { id: string; pid?: number };
  get(id: string): BackgroundTaskSnapshot | undefined;
  /** SIGKILL the task's process group. Idempotent; false for unknown ids. */
  kill(id: string): boolean;
  list(): BackgroundTaskSummary[];
  /** Kill every still-running task. Called when the session ends. */
  disposeAll(): void;
};

type TaskRecord = {
  id: string;
  runId: string;
  command: string;
  child: ChildProcess;
  startedAt: number;
  endedAt?: number;
  stdout: string;
  stderr: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  killed: boolean;
  error?: { code: string; message: string };
};

function appendRing(cur: string, text: string): string {
  const next = cur + text;
  return next.length > RING_BUFFER_CHARS ? next.slice(next.length - RING_BUFFER_CHARS) : next;
}

export function createBackgroundTasks(options: { onEvent?: (event: BackgroundTaskEvent) => void } = {}): BackgroundTasks {
  const tasks = new Map<string, TaskRecord>();
  let nextId = 0;

  function killTask(task: TaskRecord): void {
    if (task.status !== "running") return;
    task.killed = true;
    const pid = task.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL"); // whole process group
      } catch {
        try {
          task.child.kill("SIGKILL");
        } catch {
          // already gone — kill is idempotent
        }
      }
    }
  }

  return {
    start({ command, cwd, sandbox, workspace = cwd }) {
      if (sandbox !== undefined && sandbox !== "off" && buildSandboxSpec(sandbox, workspace) === null) {
        throw new ToolError(
          "sandbox_unavailable",
          "sandbox requested but sandbox-exec/bwrap not found on this system",
        );
      }
      const shell = sandboxedShell(command, sandbox, workspace);
      const id = `bg-${++nextId}`;
      const runId = `run-bg-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
      const child = spawn(shell.bin, shell.args, {
        cwd,
        detached: true, // own process group -> tree kill
        stdio: ["ignore", "pipe", "pipe"],
      });
      const task: TaskRecord = {
        id,
        runId,
        command,
        child,
        startedAt: Date.now(),
        stdout: "",
        stderr: "",
        status: "running",
        exitCode: null,
        killed: false,
      };
      tasks.set(id, task);
      options.onEvent?.({ runId, taskId: id, status: "running", attempt: 1, costUsd: 0 });

      // Decode each stream through its own StringDecoder so a multi-byte UTF-8
      // sequence split across two `data` chunks isn't mangled into U+FFFD.
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      child.stdout?.on("data", (c: Buffer) => (task.stdout = appendRing(task.stdout, outDecoder.write(c))));
      child.stderr?.on("data", (c: Buffer) => (task.stderr = appendRing(task.stderr, errDecoder.write(c))));
      child.on("error", (err) => {
        task.stderr = appendRing(task.stderr, `spawn failed: ${err.message}\n`);
        if (task.status === "running") {
          task.status = "exited";
          task.endedAt = Date.now();
        }
        task.error = { code: "spawn_failed", message: err.message };
      });
      child.on("close", (code) => {
        // Flush any bytes held back by the decoders (incomplete trailing seq).
        task.stdout = appendRing(task.stdout, outDecoder.end());
        task.stderr = appendRing(task.stderr, errDecoder.end());
        task.status = "exited";
        task.exitCode = code;
        task.endedAt = task.endedAt ?? Date.now();
        options.onEvent?.({
          runId,
          taskId: id,
          status: task.killed ? "cancelled" : code === 0 ? "succeeded" : "failed",
          attempt: 1,
          costUsd: 0,
          ...(task.error ? { error: task.error } : code && code !== 0 ? { error: { code: "exit_nonzero", message: `command exited ${code}` } } : {}),
        });
      });

      return { id, ...(child.pid !== undefined ? { pid: child.pid } : {}) };
    },

    get(id) {
      const t = tasks.get(id);
      if (!t) return undefined;
      return {
        id: t.id,
        runId: t.runId,
        command: t.command,
        status: t.status,
        ...(t.status === "exited" ? { exitCode: t.exitCode } : {}),
        stdout: t.stdout,
        stderr: t.stderr,
        durationMs: (t.endedAt ?? Date.now()) - t.startedAt,
        ...(t.child.pid !== undefined ? { pid: t.child.pid } : {}),
        attempt: 1,
        costUsd: 0,
        ...(t.error ? { error: t.error } : {}),
      };
    },

    kill(id) {
      const t = tasks.get(id);
      if (!t) return false;
      killTask(t);
      return true;
    },

    list() {
      return [...tasks.values()].map((t) => ({
        id: t.id,
        runId: t.runId,
        command: t.command,
        status: t.status,
        startedAt: new Date(t.startedAt).toISOString(),
        durationMs: (t.endedAt ?? Date.now()) - t.startedAt,
        attempt: 1,
      }));
    },

    disposeAll() {
      for (const t of tasks.values()) killTask(t);
    },
  };
}
