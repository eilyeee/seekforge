import { spawn, type ChildProcess } from "node:child_process";

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
  start(input: { command: string; cwd: string }): { id: string; pid?: number };
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

function appendRing(cur: string, chunk: Buffer): string {
  const next = cur + chunk.toString("utf8");
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
    start({ command, cwd }) {
      const id = `bg-${++nextId}`;
      const child = spawn("/bin/sh", ["-c", command], {
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

      child.stdout?.on("data", (c: Buffer) => (task.stdout = appendRing(task.stdout, c)));
      child.stderr?.on("data", (c: Buffer) => (task.stderr = appendRing(task.stderr, c)));
      child.on("error", (err) => {
        task.stderr = appendRing(task.stderr, Buffer.from(`spawn failed: ${err.message}\n`));
        if (task.status === "running") {
          task.status = "exited";
          task.endedAt = Date.now();
        }
      });
      child.on("close", (code) => {
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
