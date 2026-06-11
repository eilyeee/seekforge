/**
 * User-configured shell hooks fired around tool execution and at session end.
 *
 * Hooks are local commands the USER wrote in their own config — they run
 * as-is via `/bin/sh -c`. SECURITY: model-controlled content (tool args, raw
 * commands, paths) is delivered ONLY via the JSON stdin payload and fixed env
 * vars; it is never interpolated into the hook command line.
 *
 * Semantics:
 * - preToolUse: a hook exiting non-zero BLOCKS the tool; later preToolUse
 *   hooks are skipped. The outcome carries the output tail as the reason.
 * - postToolUse / sessionEnd: failures are logged (stderr) but never block.
 * - Hooks run sequentially in config order.
 */
import { spawn } from "node:child_process";

export type HookStage = "preToolUse" | "postToolUse" | "sessionEnd";

export type HookEntry = {
  /** Tool name this hook applies to, or "*" for any tool (default "*"). */
  match?: string;
  /**
   * Prefix tested against the classified raw command (run_command family) or
   * path (fs tools), like PermissionRule.match. Absent = any call.
   */
  pattern?: string;
  /** Shell command, run via `/bin/sh -c` with cwd = workspace. */
  command: string;
};

export type HookConfig = {
  preToolUse?: HookEntry[];
  postToolUse?: HookEntry[];
  sessionEnd?: HookEntry[];
};

/** Delivered to each hook as JSON on stdin, as `{ stage, ...payload }`. */
export type HookPayload = {
  sessionId: string;
  /** Absolute workspace path (also the hook's cwd). */
  workspace: string;
  /** Tool stages only. */
  toolName?: string;
  /** Parsed tool arguments (tool stages only). */
  args?: unknown;
  /** Classified raw command, when the call runs a command. */
  command?: string;
  /** Classified raw path, when the call touches a file. */
  path?: string;
  /** postToolUse only: outcome summary — never the raw tool output. */
  result?: { ok: boolean; errorCode: string | null };
  /** sessionEnd only: final session status. */
  status?: string;
};

export type HookOutcome = {
  /** The hook's configured shell command (user-authored). */
  command: string;
  /** True when the hook exited 0. */
  ok: boolean;
  exitCode: number | null;
  /** Tail of interleaved stdout+stderr; the block reason on preToolUse. */
  outputTail: string;
  timedOut: boolean;
};

export type RunHooksOptions = {
  /** Per-hook timeout (default 10s). */
  timeoutMs?: number;
  /** Sink for non-blocking hook failures (default: console.error). */
  onError?: (message: string) => void;
};

export const HOOK_TIMEOUT_MS = 10_000;
/** Block reasons / log lines carry at most this much hook output. */
export const HOOK_OUTPUT_TAIL_CHARS = 1000;

/** Keep a bounded buffer while capturing; only the tail is ever surfaced. */
const CAPTURE_KEEP_CHARS = 8000;

function hookApplies(entry: HookEntry, payload: HookPayload): boolean {
  const tool = entry.match ?? "*";
  // sessionEnd has no toolName; tool matching only applies to tool stages.
  if (tool !== "*" && payload.toolName !== undefined && tool !== payload.toolName) {
    return false;
  }
  if (entry.pattern !== undefined) {
    const subject = (payload.command ?? payload.path ?? "").trim();
    if (!subject.startsWith(entry.pattern.trim())) return false;
  }
  return true;
}

/**
 * Runs one hook command through `/bin/sh -c` in its own process group (so a
 * timeout kills the whole tree), with the payload JSON on stdin. Never
 * throws — spawn failures surface as a failed outcome.
 */
function runOneHook(
  entry: HookEntry,
  stage: HookStage,
  stdinJson: string,
  toolName: string | undefined,
  cwd: string,
  timeoutMs: number,
): Promise<HookOutcome> {
  return new Promise<HookOutcome>((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > CAPTURE_KEEP_CHARS) output = output.slice(-CAPTURE_KEEP_CHARS);
    };
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const tail = (timedOut ? `${output}\n[hook timed out after ${timeoutMs}ms]` : output)
        .trim()
        .slice(-HOOK_OUTPUT_TAIL_CHARS);
      resolve({
        command: entry.command,
        ok: !timedOut && exitCode === 0,
        exitCode,
        outputTail: tail,
        timedOut,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", entry.command], {
        cwd,
        detached: true, // own process group -> tree kill on timeout
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          SEEKFORGE_HOOK_STAGE: stage,
          SEEKFORGE_TOOL: toolName ?? "",
        },
      });
    } catch (err) {
      output = String(err);
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      append(Buffer.from(String(err)));
      finish(null);
    });
    child.on("close", (code) => finish(code));

    // The hook may exit without reading stdin; ignore EPIPE-style errors.
    child.stdin?.on("error", () => {});
    child.stdin?.write(stdinJson);
    child.stdin?.end();
  });
}

/**
 * Runs the hooks of `stage` that match the payload, sequentially in config
 * order. preToolUse stops at the first failing hook (its outcome is the block
 * reason — callers must treat any `ok: false` outcome as blocking). For
 * postToolUse/sessionEnd every matching hook runs; failures go to
 * `opts.onError` (default stderr) and never block. Never throws.
 */
export async function runHooks(
  stage: HookStage,
  hooks: HookEntry[] | undefined,
  payload: HookPayload,
  opts: RunHooksOptions = {},
): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  if (!hooks || hooks.length === 0) return outcomes;

  const stdinJson = JSON.stringify({ stage, ...payload });
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  const onError = opts.onError ?? ((msg: string) => console.error(msg));

  for (const entry of hooks) {
    if (!hookApplies(entry, payload)) continue;
    const outcome = await runOneHook(entry, stage, stdinJson, payload.toolName, payload.workspace, timeoutMs);
    outcomes.push(outcome);
    if (outcome.ok) continue;
    if (stage === "preToolUse") break; // blocks the tool; later hooks are moot
    onError(
      `seekforge ${stage} hook failed (${entry.command}): ` +
        `${outcome.timedOut ? "timed out" : `exit ${outcome.exitCode}`}` +
        `${outcome.outputTail ? ` — ${outcome.outputTail}` : ""}`,
    );
  }
  return outcomes;
}
