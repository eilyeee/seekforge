import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { truncateHeadTail } from "./text.js";
import { callRuntime } from "./runtime-backend.js";
import { looksLikeSandboxDenial, runShellCommand, type ShellResult } from "./run-command.js";
import type { ToolContext } from "./index.js";

/**
 * Running one command in the workspace, with everything that has to happen
 * around it: the optional native runtime, the OS sandbox and its one-time
 * escalation prompt, live output streaming, secret redaction and output bounds.
 *
 * It lives here rather than inside run_command because more than one tool needs
 * to run a command — and a second implementation of this is a second place for
 * the sandbox to be bypassed.
 *
 * The permission decision is NOT made here. Every caller must classify its
 * command with `classifyCommand` first, so the user sees and approves the same
 * thing no matter which tool is asking.
 */

export type CommandExecution = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Output was capped; the middle is missing. */
  truncated: boolean;
  /** The sandbox blocked it and the user approved one unsandboxed retry. */
  sandboxEscalated: boolean;
};

export type ExecuteCommandOptions = {
  command: string;
  /** Absolute, already resolved inside the workspace by the caller. */
  cwd: string;
  timeoutMs: number;
  /** Named in the escalation prompt, so the user knows which tool is asking. */
  toolName: string;
};

/**
 * Test seam: the foreground execution path (initial run AND the unsandboxed
 * escalation retry) goes through this indirection so tests can stub the shell
 * without spawning real processes. Null restores the default.
 *
 * It belongs here rather than in one tool, because every tool that runs a
 * command runs it through this function — a seam owned by one of them would
 * silently not cover the others.
 */
let shellRunner: typeof runShellCommand = runShellCommand;
export function setShellRunnerForTests(fn: typeof runShellCommand | null): void {
  shellRunner = fn ?? runShellCommand;
}

function bound(text: string): { text: string; truncated: boolean } {
  const capped = truncateHeadTail(text, DEFAULT_LIMITS.toolOutputMaxChars);
  return { text: redactSecrets(capped.text), truncated: capped.truncated };
}

export async function executeCommandInWorkspace(
  ctx: ToolContext,
  options: ExecuteCommandOptions,
): Promise<CommandExecution> {
  const { command, cwd, timeoutMs, toolName } = options;

  // The native runtime protocol has no sandbox field. Using it while a sandbox
  // is active would silently bypass the caller's OS policy, so the wrapped
  // shell path is authoritative for every sandboxed command.
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
      { command, cwd, timeoutMs },
      // The runtime enforces the command timeout itself; this is the outer bound.
      { timeoutMs: timeoutMs + 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (r.timedOut) {
      throw new ToolError("timeout", `command timed out after ${timeoutMs}ms`, {
        timeoutMs,
        stdout: redactSecrets(r.stdout),
        stderr: redactSecrets(r.stderr),
      });
    }
    const out = bound(r.stdout);
    const err = bound(r.stderr);
    return {
      exitCode: r.exitCode,
      stdout: out.text,
      stderr: err.text,
      durationMs: r.durationMs,
      truncated: out.truncated || err.truncated,
      sandboxEscalated: false,
    };
  }

  const execute = async (sandbox: typeof ctx.sandbox): Promise<ShellResult> => {
    try {
      return await shellRunner(command, cwd, timeoutMs, {
        ...(sandbox !== undefined ? { sandbox } : {}),
        workspace: ctx.workspace,
        ...(ctx.emitOutput ? { onOutput: ctx.emitOutput } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      if (err instanceof ToolError && err.code === "timeout") {
        const d = err.detail as { timeoutMs: number; stdout: string; stderr: string };
        throw new ToolError(err.code, err.message, {
          timeoutMs: d.timeoutMs,
          stdout: bound(d.stdout).text,
          stderr: bound(d.stderr).text,
        });
      }
      throw err;
    }
  };

  const settle = (res: ShellResult, sandboxEscalated: boolean): CommandExecution => {
    const out = bound(res.stdout);
    const err = bound(res.stderr);
    return {
      exitCode: res.exitCode,
      stdout: out.text,
      stderr: err.text,
      durationMs: res.durationMs,
      truncated: out.truncated || err.truncated,
      sandboxEscalated,
    };
  };

  const res = await execute(ctx.sandbox);

  // Sandbox escalation (Codex-style): when the policy sandbox is active and the
  // failure output looks like a sandbox denial (not a genuine command error),
  // offer ONE unsandboxed retry. confirm decides — auto-deny modes simply keep
  // the original failure. sandbox_unavailable setup errors throw above and
  // never reach this path.
  const sandboxActive = ctx.sandbox !== undefined && ctx.sandbox !== "off";
  if (sandboxActive && res.exitCode !== 0 && looksLikeSandboxDenial(`${res.stdout}\n${res.stderr}`)) {
    const approved = await ctx.confirm({
      toolName,
      permission: "execute",
      description: "Command failed inside the sandbox — retry WITHOUT sandbox?",
      command,
    });
    if (typeof approved === "boolean" ? approved : approved.allow) {
      return settle(await execute("off"), true);
    }
  }

  return settle(res, false);
}
