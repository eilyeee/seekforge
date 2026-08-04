/**
 * Agent-runner contract (Track E: remote / isolated execution).
 *
 * A "runner" is any environment that can execute one SeekForge task against a
 * workspace and produce a normal, auditable session. The point of this contract
 * is that the SAME task can run:
 *   - locally (the default `seekforge run`),
 *   - inside a Docker container (the reference runner in `docker-runner.ts`),
 *   - on a remote workstation, or
 *   - in a VM,
 * behind one small, stable interface. Callers depend on {@link AgentRunner};
 * each backend maps {@link RunnerOptions} onto its own launch mechanism.
 *
 * The contract is intentionally minimal — the shared inputs every backend needs
 * (what task, in which workspace, which model/provider/mode, and the cost cap)
 * and the shared result (did it produce a session, and how did the process
 * exit). Backend-specific knobs (e.g. Docker's network/memory/cpus) live in the
 * backend's own option type, which extends {@link RunnerOptions}.
 */

/**
 * Quote one argument for a POSIX shell.
 *
 * Single quotes take everything literally except a single quote itself, which
 * is closed, escaped and reopened. Two places need this and they need it for
 * different reasons: a backend whose transport hands the command to a remote
 * shell, and every backend's `--check` output, which is printed so a human can
 * paste it into their own shell. A rendering quoted for JSON instead would look
 * right and execute the backticks in a task the moment it was pasted.
 */
export function shellQuote(value: string): string {
  // close the quote, emit an escaped quote, reopen: it's -> 'it'\''s'
  return `'${value.split("'").join("'\\''")}'`;
}

/** Render an argv as a copy-pasteable command line, safe to paste as printed. */
export function formatCommandLine(binary: string, args: string[]): string {
  return [binary, ...args.map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : shellQuote(arg)))].join(" ");
}

/** Ask (read-only Q&A) vs. edit (can write files / run commands). Mirrors the CLI. */
export type RunnerMode = "ask" | "edit";

/** The inputs every runner backend accepts. */
export interface RunnerOptions {
  /** The task/prompt to execute. */
  task: string;
  /**
   * Absolute path to the workspace the agent operates on. A remote/isolated
   * runner mounts (or syncs) exactly this directory and nothing else.
   */
  workspacePath: string;
  /** Override the model (else the workspace/global config decides). */
  model?: string;
  /** Override the provider (`deepseek` | `ark`; else config decides). */
  provider?: string;
  /** Ask vs. edit. Defaults to `edit`. */
  mode?: RunnerMode;
  /** Per-run cost cap in USD. The run aborts once cumulative cost reaches it. */
  maxCostUsd?: number;
  /**
   * Per-run wall-clock cap in seconds. Enforced by the run INSIDE the backend,
   * not by the launcher: a container or a remote host that stops answering is
   * exactly the case a launcher-side timer cannot see.
   */
  maxDurationSeconds?: number;
  /**
   * Runner image/identifier. For Docker this is the image tag; a VM/remote
   * backend may reuse it as a base image / host id. Optional — each backend
   * has a sane default.
   */
  image?: string;
}

/** The result every runner backend returns. */
export interface RunnerResult {
  /** The session id produced by the run, if one was created (for `seekforge audit`). */
  sessionId?: string;
  /** The launcher process exit code (0 = success). */
  exitCode: number;
  /** Which backend produced this result (e.g. `docker`, `local`). */
  runner: string;
}

/**
 * A runner backend: something that can execute one task against a workspace.
 * Implementations are thin — they translate {@link RunnerOptions} into their
 * own launch mechanism and stream the child's output through.
 */
export interface AgentRunner {
  /** Stable backend name, surfaced in {@link RunnerResult.runner}. */
  readonly name: string;
  /** Execute the task and resolve once the underlying process exits. */
  run(opts: RunnerOptions): Promise<RunnerResult>;
}
