import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { truncateHeadTail } from "../text.js";
import {
  classifyCommand,
  looksLikeSandboxDenial,
  normalizeCommand,
  runShellCommand,
  type ShellResult,
} from "../run-command.js";
import { callRuntime } from "../runtime-backend.js";
import { defineTool, type ToolRunOutput, type ToolSpec } from "../registry.js";

/**
 * Test seam: the foreground execution path (initial run AND the unsandboxed
 * escalation retry) goes through this indirection so tests can stub the
 * shell without spawning real processes. Null restores the default.
 */
let shellRunner: typeof runShellCommand = runShellCommand;
export function setShellRunnerForTests(fn: typeof runShellCommand | null): void {
  shellRunner = fn ?? runShellCommand;
}

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

    // The native runtime protocol has no sandbox field. Using it while a
    // sandbox is active would silently bypass the caller's OS policy, so the
    // wrapped shell path is authoritative for every sandboxed command.
    if (ctx.runtime && (ctx.sandbox === undefined || ctx.sandbox === "off")) {
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
        {
          timeoutMs: timeoutMs + 30_000,
          signal: ctx.signal,
        }, // runtime enforces the command timeout itself
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

    // Foreground execution; used for both the initial (possibly sandboxed)
    // run and the unsandboxed escalation retry. Output is streamed live via
    // ctx.emitOutput when the loop provides it.
    const execute = async (sandbox: typeof ctx.sandbox): Promise<ShellResult> => {
      try {
        return await shellRunner(args.command, cwd, timeoutMs, {
          sandbox,
          workspace: ctx.workspace,
          onOutput: ctx.emitOutput,
          signal: ctx.signal,
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
    };

    const finish = (res: ShellResult, sandboxEscalated = false): ToolRunOutput => {
      const out = truncateHeadTail(res.stdout, DEFAULT_LIMITS.toolOutputMaxChars);
      const errOut = truncateHeadTail(res.stderr, DEFAULT_LIMITS.toolOutputMaxChars);
      return {
        data: {
          exitCode: res.exitCode,
          stdout: redactSecrets(out.text),
          stderr: redactSecrets(errOut.text),
          durationMs: res.durationMs,
        },
        meta: {
          truncated: out.truncated || errOut.truncated,
          ...(sandboxEscalated ? { sandboxEscalated: true } : {}),
        },
      };
    };

    const res = await execute(ctx.sandbox);

    // Sandbox escalation (Codex-style): when the policy sandbox is active and
    // the failure output looks like a sandbox denial (not a genuine command
    // error), offer ONE unsandboxed retry. confirm decides — auto-deny modes
    // simply keep the original failure. sandbox_unavailable setup errors throw
    // above and never reach this path.
    const sandboxActive = ctx.sandbox !== undefined && ctx.sandbox !== "off";
    if (sandboxActive && res.exitCode !== 0 && looksLikeSandboxDenial(`${res.stdout}\n${res.stderr}`)) {
      const approved = await ctx.confirm({
        toolName: "run_command",
        permission: "execute",
        description: "Command failed inside the sandbox — retry WITHOUT sandbox?",
        command: args.command,
      });
      if (typeof approved === "boolean" ? approved : approved.allow) {
        return finish(await execute("off"), true);
      }
    }

    return finish(res);
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
