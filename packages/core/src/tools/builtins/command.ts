import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { truncateHeadTail } from "../text.js";
import { classifyCommand, normalizeCommand, runShellCommand } from "../run-command.js";
import { callRuntime } from "../runtime-backend.js";
import { defineTool, type ToolSpec } from "../registry.js";

const runCommandSchema = z.object({
  command: z.string().describe("Shell command line to run via /bin/sh -c."),
  cwd: z.string().optional().describe("Working directory, relative to the workspace root."),
  timeoutMs: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (defaults: 30s, 120s for tests, 180s for builds)."),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run without waiting; returns a taskId for task_output/task_kill. Use for dev servers and watchers.",
    ),
});

const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a shell command inside the workspace. Output is truncated and secrets are redacted. Destructive commands are refused; dependency installs require confirmation.",
  schema: runCommandSchema,
  classify: (args, ctx) => {
    const cls = classifyCommand(args.command, ctx.policy.commandAllowlist);
    return {
      permission: cls.permission,
      description:
        cls.permission === "dangerous"
          ? `Refused command (${cls.reason}): ${normalizeCommand(args.command)}`
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
        throw new ToolError(
          "background_unavailable",
          "background tasks are not available in this session",
        );
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

    if (ctx.runtime) {
      const r = await callRuntime<{
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
        timedOut: boolean;
      }>(
        ctx.runtime,
        "run_command",
        ctx.workspace,
        { command: args.command, cwd: args.cwd ?? ".", timeoutMs },
        { timeoutMs: timeoutMs + 30_000 }, // runtime enforces the command timeout itself
      );
      if (r.timedOut) {
        throw new ToolError("timeout", `command timed out after ${timeoutMs}ms`, {
          timeoutMs,
          stdout: redactSecrets(r.stdout),
          stderr: redactSecrets(r.stderr),
        });
      }
      return {
        data: {
          exitCode: r.exitCode,
          stdout: redactSecrets(r.stdout),
          stderr: redactSecrets(r.stderr),
          durationMs: r.durationMs,
        },
      };
    }

    let res;
    try {
      res = await runShellCommand(args.command, cwd, timeoutMs, {
        sandbox: ctx.sandbox,
        workspace: ctx.workspace,
      });
    } catch (err) {
      if (err instanceof ToolError && err.code === "timeout") {
        const d = err.detail as { timeoutMs: number; stdout: string; stderr: string };
        throw new ToolError(err.code, err.message, {
          timeoutMs: d.timeoutMs,
          stdout: redactSecrets(truncateHeadTail(d.stdout, DEFAULT_LIMITS.toolOutputMaxChars).text),
          stderr: redactSecrets(truncateHeadTail(d.stderr, DEFAULT_LIMITS.toolOutputMaxChars).text),
        });
      }
      throw err;
    }

    const out = truncateHeadTail(res.stdout, DEFAULT_LIMITS.toolOutputMaxChars);
    const errOut = truncateHeadTail(res.stderr, DEFAULT_LIMITS.toolOutputMaxChars);
    return {
      data: {
        exitCode: res.exitCode,
        stdout: redactSecrets(out.text),
        stderr: redactSecrets(errOut.text),
        durationMs: res.durationMs,
      },
      meta: { truncated: out.truncated || errOut.truncated },
    };
  },
});

const DEFAULT_TASK_OUTPUT_TAIL_CHARS = 2_000;

const taskOutputSchema = z.object({
  taskId: z.string().describe("Background task id returned by run_command with background:true."),
  tail: z
    .number()
    .optional()
    .describe("Return only the last N chars of each stream (default 2000)."),
});

const taskOutput = defineTool({
  name: "task_output",
  description:
    "Read the latest stdout/stderr and status of a background task started via run_command with background:true.",
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
    const tail = Math.max(
      0,
      Math.min(args.tail ?? DEFAULT_TASK_OUTPUT_TAIL_CHARS, DEFAULT_LIMITS.toolOutputMaxChars),
    );
    return {
      data: {
        taskId: task.id,
        command: task.command,
        status: task.status,
        ...(task.status === "exited" ? { exitCode: task.exitCode ?? null } : {}),
        stdout: redactSecrets(task.stdout.slice(-tail)),
        stderr: redactSecrets(task.stderr.slice(-tail)),
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
  description: "Kill a background task started in this session (SIGKILL to its process group).",
  schema: taskKillSchema,
  classify: (args, ctx) => {
    const task = ctx.background?.get(args.taskId);
    return {
      // "write": it only kills tasks this session itself started.
      permission: "write",
      description: task
        ? `Kill background task ${task.id} (${task.command})`
        : `Kill background task ${args.taskId}`,
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
