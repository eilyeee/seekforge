/**
 * User-configured shell hooks fired around tool execution and at session
 * lifecycle points.
 *
 * Hooks are local commands the USER wrote in their own config — they run
 * as-is via `/bin/sh -c`. SECURITY: model-controlled content (tool args, raw
 * commands, paths) is delivered ONLY via the JSON stdin payload and fixed env
 * vars; it is never interpolated into the hook command line.
 *
 * Stages (payload fields beyond { sessionId, workspace }):
 * | stage            | fires                                        | blocking | stdout (exit 0)                  | payload extras                  |
 * |------------------|----------------------------------------------|----------|----------------------------------|---------------------------------|
 * | preToolUse       | before each tool runs                        | YES      | JSON {"decision": …} (see below) | toolName, args, command?, path? |
 * | postToolUse      | after each tool ran                          | no       | ignored                          | toolName, args, result          |
 * | sessionStart     | top-level run begins                         | no       | ignored                          | task, mode, resuming            |
 * | userPromptSubmit | right after sessionStart, for the task       | YES      | appended as <hook-context>       | task                            |
 * | preCompact       | before compaction mutates the messages       | no       | ignored                          | reason ("auto")                 |
 * | stop             | after session.completed (not fail/cancel)    | no       | ignored                          | summary                         |
 * | subagentStop     | a dispatched subagent run finished           | no       | ignored                          | agentId, ok                     |
 * | notification     | permission prompt or ask_user question shown | no       | ignored                          | kind, detail                    |
 * | sessionEnd       | top-level session ended (any status)         | no       | ignored                          | status                          |
 *
 * Semantics:
 * - Blocking stages (preToolUse, userPromptSubmit): a hook exiting non-zero
 *   BLOCKS the tool/run; later hooks of that stage are skipped. The outcome
 *   carries the output tail as the reason.
 * - preToolUse stdout decisions (exit 0 only): stdout parsing as JSON
 *   `{"decision": "deny", "reason": "…"}` blocks the call with that reason;
 *   `{"decision": "allow"}` explicitly allows and SKIPS the remaining
 *   preToolUse hooks. Any other stdout (including malformed JSON) is ignored
 *   and the exit-code behavior above applies unchanged.
 * - userPromptSubmit stdout (trimmed, non-empty, exit 0) is context for the
 *   model: the loop appends each hook's stdout to the task as
 *   `\n\n<hook-context>\n…\n</hook-context>` (see buildHookContext), capped
 *   at HOOK_CONTEXT_MAX_CHARS in total.
 * - All other stages are advisory: failures are logged (stderr), never block;
 *   their stdout is captured (HookOutcome.stdout) but has no semantics.
 * - sessionStart, userPromptSubmit and stop fire only for the TOP-LEVEL run
 *   (like sessionEnd); nested subagent runs never fire them.
 * - Hooks run sequentially in config order.
 */
import { spawn } from "node:child_process";

export type HookStage =
  | "preToolUse"
  | "postToolUse"
  | "sessionStart"
  | "userPromptSubmit"
  | "preCompact"
  | "stop"
  | "subagentStop"
  | "notification"
  | "sessionEnd";

/** Stages where a non-zero exit blocks (tool call / run) instead of logging. */
const BLOCKING_STAGES: ReadonlySet<HookStage> = new Set(["preToolUse", "userPromptSubmit"]);

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
  sessionStart?: HookEntry[];
  userPromptSubmit?: HookEntry[];
  preCompact?: HookEntry[];
  stop?: HookEntry[];
  subagentStop?: HookEntry[];
  notification?: HookEntry[];
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
  /** sessionStart / userPromptSubmit: the submitted task text. */
  task?: string;
  /** sessionStart only: run mode ("ask" | "edit"). */
  mode?: string;
  /** sessionStart only: true when the run resumes an existing session. */
  resuming?: boolean;
  /** preCompact only: why compaction runs ("auto"). */
  reason?: string;
  /** stop only: the final assistant summary. */
  summary?: string;
  /** subagentStop only: the finished subagent's definition id. */
  agentId?: string;
  /** subagentStop only: whether the subagent run produced a report. */
  ok?: boolean;
  /** notification only: what the user is being asked. */
  kind?: "permission" | "question";
  /** notification only: the permission request / question object. */
  detail?: unknown;
};

export type HookOutcome = {
  /** The hook's configured shell command (user-authored). */
  command: string;
  /**
   * True when the hook exited 0 — except a preToolUse JSON deny, which is
   * surfaced as ok: false (with decision: "deny") so existing callers treat
   * it as a block.
   */
  ok: boolean;
  exitCode: number | null;
  /** Tail of interleaved stdout+stderr; the block reason on blocking stages. */
  outputTail: string;
  /** The hook's stdout alone (head, capped at 8000 chars) — context/decision input. */
  stdout: string;
  /** preToolUse only: the parsed JSON stdout decision, when one was given. */
  decision?: "allow" | "deny";
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
    let stdout = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > CAPTURE_KEEP_CHARS) output = output.slice(-CAPTURE_KEEP_CHARS);
    };
    // stdout is also captured on its own (head-capped: context reads from the
    // start) — it carries the userPromptSubmit context / preToolUse decisions.
    const appendStdout = (chunk: Buffer): void => {
      if (stdout.length < CAPTURE_KEEP_CHARS) {
        stdout = (stdout + chunk.toString("utf8")).slice(0, CAPTURE_KEEP_CHARS);
      }
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
        stdout,
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

    child.stdout?.on("data", (chunk: Buffer) => {
      append(chunk);
      appendStdout(chunk);
    });
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
 * Parses a preToolUse hook's stdout as a JSON decision. Returns undefined for
 * anything that is not a JSON object with decision "allow" | "deny" —
 * malformed JSON or other stdout never changes behavior.
 */
function parseToolDecision(stdout: string): { decision: "allow" | "deny"; reason?: string } | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const decision = (parsed as Record<string, unknown>)["decision"];
  if (decision !== "allow" && decision !== "deny") return undefined;
  const reason = (parsed as Record<string, unknown>)["reason"];
  return { decision, ...(typeof reason === "string" ? { reason } : {}) };
}

/** Total stdout budget for userPromptSubmit <hook-context> injection. */
export const HOOK_CONTEXT_MAX_CHARS = 8000;

/**
 * Builds the task suffix injected from userPromptSubmit hooks: each
 * successful hook's trimmed, non-empty stdout becomes one
 * `\n\n<hook-context>\n…\n</hook-context>` block, in hook order. The combined
 * stdout is capped at HOOK_CONTEXT_MAX_CHARS. Returns "" when no hook
 * contributed anything.
 */
export function buildHookContext(outcomes: HookOutcome[]): string {
  let budget = HOOK_CONTEXT_MAX_CHARS;
  let suffix = "";
  for (const o of outcomes) {
    if (!o.ok || budget <= 0) continue;
    const text = o.stdout.trim();
    if (!text) continue;
    const clipped = text.slice(0, budget);
    budget -= clipped.length;
    const marker = clipped.length < text.length ? "…[truncated]" : "";
    suffix += `\n\n<hook-context>\n${clipped}${marker}\n</hook-context>`;
  }
  return suffix;
}

/**
 * Runs the hooks of `stage` that match the payload, sequentially in config
 * order. Blocking stages (preToolUse, userPromptSubmit) stop at the first
 * failing hook (its outcome is the block reason — callers must treat any
 * `ok: false` outcome as blocking; a preToolUse JSON deny is surfaced the
 * same way, with the reason as outputTail). A preToolUse JSON allow stops
 * the stage early with the remaining hooks skipped. For every other stage
 * all matching hooks run; failures go to `opts.onError` (default stderr) and
 * never block. Never throws.
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

    // preToolUse JSON stdout decisions (exit 0 only): deny blocks with the
    // given reason; allow short-circuits the remaining preToolUse hooks.
    // Anything else falls through to plain exit-code semantics.
    if (stage === "preToolUse" && outcome.ok) {
      const d = parseToolDecision(outcome.stdout);
      if (d?.decision === "deny") {
        outcomes.push({
          ...outcome,
          ok: false,
          decision: "deny",
          outputTail: (d.reason ?? "denied by preToolUse hook").slice(0, HOOK_OUTPUT_TAIL_CHARS),
        });
        break; // blocks the tool; later hooks are moot
      }
      if (d?.decision === "allow") {
        outcomes.push({ ...outcome, decision: "allow" });
        break; // explicit allow: skip the remaining preToolUse hooks
      }
    }

    outcomes.push(outcome);
    if (outcome.ok) continue;
    if (BLOCKING_STAGES.has(stage)) break; // blocks the tool/run; later hooks are moot
    onError(
      `seekforge ${stage} hook failed (${entry.command}): ` +
        `${outcome.timedOut ? "timed out" : `exit ${outcome.exitCode}`}` +
        `${outcome.outputTail ? ` — ${outcome.outputTail}` : ""}`,
    );
  }
  return outcomes;
}
