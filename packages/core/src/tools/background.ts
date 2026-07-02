import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ToolError } from "./errors.js";
import { buildSandboxSpec, sandboxedShell, type SandboxLevel } from "./os-sandbox.js";

/** Per-stream ring buffer: keep only the LAST N chars of stdout/stderr. */
const RING_BUFFER_CHARS = 100_000;

export type BackgroundTaskStatus = "running" | "exited";

export type BackgroundTaskSnapshot = {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  /** Present once the task exited; null when killed (no exit code). */
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  pid?: number;
};

export type BackgroundTaskSummary = {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  startedAt: string;
  durationMs: number;
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
    sandbox?: SandboxLevel | undefined;
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
  command: string;
  child: ChildProcess;
  startedAt: number;
  endedAt?: number;
  stdout: string;
  stderr: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
};

function appendRing(cur: string, text: string): string {
  const next = cur + text;
  return next.length > RING_BUFFER_CHARS ? next.slice(next.length - RING_BUFFER_CHARS) : next;
}

export function createBackgroundTasks(): BackgroundTasks {
  const tasks = new Map<string, TaskRecord>();
  let nextId = 0;

  function killTask(task: TaskRecord): void {
    if (task.status !== "running") return;
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
      const child = spawn(shell.bin, shell.args, {
        cwd,
        detached: true, // own process group -> tree kill
        stdio: ["ignore", "pipe", "pipe"],
      });
      const task: TaskRecord = {
        id,
        command,
        child,
        startedAt: Date.now(),
        stdout: "",
        stderr: "",
        status: "running",
        exitCode: null,
      };
      tasks.set(id, task);

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
      });
      child.on("close", (code) => {
        // Flush any bytes held back by the decoders (incomplete trailing seq).
        task.stdout = appendRing(task.stdout, outDecoder.end());
        task.stderr = appendRing(task.stderr, errDecoder.end());
        task.status = "exited";
        task.exitCode = code;
        task.endedAt = task.endedAt ?? Date.now();
      });

      return { id, ...(child.pid !== undefined ? { pid: child.pid } : {}) };
    },

    get(id) {
      const t = tasks.get(id);
      if (!t) return undefined;
      return {
        id: t.id,
        command: t.command,
        status: t.status,
        ...(t.status === "exited" ? { exitCode: t.exitCode } : {}),
        stdout: t.stdout,
        stderr: t.stderr,
        durationMs: (t.endedAt ?? Date.now()) - t.startedAt,
        ...(t.child.pid !== undefined ? { pid: t.child.pid } : {}),
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
        command: t.command,
        status: t.status,
        startedAt: new Date(t.startedAt).toISOString(),
        durationMs: (t.endedAt ?? Date.now()) - t.startedAt,
      }));
    },

    disposeAll() {
      for (const t of tasks.values()) killTask(t);
    },
  };
}
