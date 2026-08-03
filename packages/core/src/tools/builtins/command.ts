import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { classifyCommand, normalizeCommand } from "../run-command.js";
import { executeCommandInWorkspace } from "../shell-execution.js";
import { defineTool, type ToolSpec } from "../registry.js";

// The shell seam is owned by shell-execution.ts, which every command-running
// tool goes through; re-exported here for the tests that already import it.
export { setShellRunnerForTests } from "../shell-execution.js";

const runCommandSchema = z.object({
  command: z.string().describe("Non-interactive shell command line to run via /bin/sh -c."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory for this command, relative to the workspace root (default '.'). Use this to run in a subdir instead of chaining 'cd <dir> && ...'. Each call is a fresh /bin/sh, so shell state (env vars, activated venvs, a prior 'cd') does NOT persist between calls.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30 * 60 * 1000)
    .optional()
    .describe("Timeout in milliseconds (1-1800000; defaults: 30s, 120s for tests, 180s for builds)."),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run without waiting; returns a taskId immediately. Use for long-running processes that do not exit on their own (dev servers, watchers); read their output via task_output and stop them with task_kill.",
    ),
});

const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a non-interactive command via /bin/sh -c at the workspace root or cwd. Secret environment variables are removed. Timeouts: 30s (tests 120s, builds 180s). Output is head/tail-truncated at 20,000 chars and redacted. For processes that do not exit (servers, watchers), pass background:true, then use task_output or task_kill with the returned taskId. Do not start interactive programs. Destructive commands are refused; installs require confirmation.",
  schema: runCommandSchema,
  classify: (args, ctx) => {
    const cls = classifyCommand(args.command, ctx.policy.commandAllowlist);
    return {
      permission: cls.permission,
      description:
        cls.permission === "dangerous"
          ? `Refused command (${cls.reason}): ${normalizeCommand(args.command)}`
          : cls.permission === "readonly"
            ? `Read command (${cls.reason}): ${normalizeCommand(args.command)}`
            : `Run command: ${normalizeCommand(args.command)}`,
      command: args.command,
      allowlisted: cls.allowlisted,
    };
  },
  async run(args, ctx) {
    const cls = classifyCommand(args.command, ctx.policy.commandAllowlist);
    const cwd = resolveInsideWorkspace(ctx.workspace, args.cwd ?? ".");
    const timeoutMs = args.timeoutMs ?? cls.defaultTimeoutMs;

    if (args.background) {
      if (!ctx.background) {
        throw new ToolError("background_unavailable", "background tasks are not available in this session");
      }
      const { id } = ctx.background.start({
        command: args.command,
        cwd,
        sandbox: ctx.sandbox,
        workspace: ctx.workspace,
      });
      return {
        data: {
          taskId: id,
          command: args.command,
          note: "running in background; poll with task_output",
        },
      };
    }

    const execution = await executeCommandInWorkspace(ctx, {
      command: args.command,
      cwd,
      timeoutMs,
      toolName: "run_command",
    });
    return {
      data: {
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
      },
      meta: {
        truncated: execution.truncated,
        ...(execution.sandboxEscalated ? { sandboxEscalated: true } : {}),
      },
    };
  },
});

const DEFAULT_TASK_OUTPUT_TAIL_CHARS = 2_000;

const taskOutputSchema = z.object({
  taskId: z.string().describe("Background task id returned by run_command with background:true."),
  tail: z
    .number()
    .int()
    .min(0)
    .max(DEFAULT_LIMITS.toolOutputMaxChars)
    .optional()
    .describe("Return only the last N chars of each stream (default 2000)."),
});

const taskOutput = defineTool({
  name: "task_output",
  description:
    "Read the latest stdout/stderr and status of the background task taskId started via run_command with background:true (tail defaults to the last 2000 chars per stream). Do not poll in a tight loop — do other useful work between checks, then poll again.",
  schema: taskOutputSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read output of background task ${args.taskId}`,
  }),
  async run(args, ctx) {
    const task = ctx.background?.get(args.taskId);
    if (!task) {
      throw new ToolError("unknown_task", `Unknown background task: ${args.taskId}`);
    }
    const tail = Math.max(0, Math.min(args.tail ?? DEFAULT_TASK_OUTPUT_TAIL_CHARS, DEFAULT_LIMITS.toolOutputMaxChars));
    // slice(-0) is slice(0) — the WHOLE buffer — so tail:0 must short-circuit
    // to empty rather than return everything.
    const lastChars = (s: string): string => (tail === 0 ? "" : s.slice(-tail));
    return {
      data: {
        taskId: task.id,
        command: task.command,
        status: task.status,
        ...(task.status === "exited" ? { exitCode: task.exitCode ?? null } : {}),
        stdout: redactSecrets(lastChars(task.stdout)),
        stderr: redactSecrets(lastChars(task.stderr)),
        durationMs: task.durationMs,
      },
    };
  },
});

const taskKillSchema = z.object({
  taskId: z.string().describe("Background task id returned by run_command with background:true."),
});

const taskKill = defineTool({
  name: "task_kill",
  description:
    "Kill the background task taskId started in this session (SIGKILL to its process group). Use when a server/watcher is no longer needed or must be restarted.",
  schema: taskKillSchema,
  classify: (args, ctx) => {
    const task = ctx.background?.get(args.taskId);
    return {
      // "write": it only kills tasks this session itself started.
      permission: "write",
      description: task ? `Kill background task ${task.id} (${task.command})` : `Kill background task ${args.taskId}`,
      ...(task ? { command: task.command } : {}),
    };
  },
  async run(args, ctx) {
    const task = ctx.background?.get(args.taskId);
    if (!task || !ctx.background) {
      throw new ToolError("unknown_task", `Unknown background task: ${args.taskId}`);
    }
    ctx.background.kill(args.taskId);
    return { data: { taskId: args.taskId, killed: true } };
  },
});

export const commandTools: ToolSpec[] = [runCommand, taskOutput, taskKill];
