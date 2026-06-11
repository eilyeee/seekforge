/**
 * User-defined shell hooks fired around tool calls (Claude Code-style).
 *
 * A hook is a shell command spawned with the JSON payload on stdin and the
 * event/tool name in the environment. preToolUse hooks gate execution: a
 * non-zero exit BLOCKS the tool. postToolUse / sessionEnd hooks are advisory.
 *
 * Tool-name matching uses a deliberately tiny glob: "*" (all), "prefix_*"
 * (prefix), or an exact name. No nested segments, no character classes.
 */

import { spawn } from "node:child_process";

export type HookDef = {
  /** Tool-name glob: "*", "run_command", "git_*". Defaults to "*" when unset. */
  match?: string;
  /** Shell command, run via `/bin/sh -c`. */
  command: string;
};

export type HooksConfig = {
  preToolUse?: HookDef[];
  postToolUse?: HookDef[];
  sessionEnd?: HookDef[];
};

export type HookPhase = "preToolUse" | "postToolUse" | "sessionEnd";

export type HookOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const HOOK_TIMEOUT_MS = 10_000;
const OUTPUT_CAP = 10_000;

/** Tiny glob: "*" matches everything, "prefix_*" matches by prefix, else exact. */
export function matchTool(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) : s;
}

/**
 * Spawns `/bin/sh -c <command>` with the payload as JSON on stdin and the
 * SEEKFORGE_HOOK_EVENT / SEEKFORGE_TOOL_NAME env vars set. Captures stdout and
 * stderr (each capped at 10k). A 10s timeout kills the process and surfaces a
 * non-zero exit code. Never throws — spawn failures map to exitCode 1.
 */
export function runHook(
  def: HookDef,
  payload: { event: HookPhase; toolName?: string; [k: string]: unknown },
  cwd: string,
): Promise<HookOutcome> {
  return new Promise<HookOutcome>((resolve) => {
    const child = spawn("/bin/sh", ["-c", def.command], {
      cwd,
      env: {
        ...process.env,
        SEEKFORGE_HOOK_EVENT: payload.event,
        ...(payload.toolName ? { SEEKFORGE_TOOL_NAME: payload.toolName } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: HookOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: 124, stdout: cap(stdout), stderr: cap(`${stderr}\n[hook timed out after 10s]`) });
    }, HOOK_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish({ exitCode: 1, stdout: cap(stdout), stderr: cap(`${stderr}${String(err)}`) });
    });
    child.on("close", (code) => {
      finish({ exitCode: code ?? 1, stdout: cap(stdout), stderr: cap(stderr) });
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      // stdin may already be closed if the child exited immediately; ignore.
    }
  });
}

/**
 * Synthetic meta tools have no real side effects, so hooks never fire for them:
 * update_plan and agent_result are pure read-only meta, task_output is a
 * progress channel. Everything else (real builtins, MCP tools, dispatch_agent,
 * agent_send) is hookable.
 */
export function isHookableTool(name: string): boolean {
  return name !== "update_plan" && name !== "agent_result" && name !== "task_output";
}
