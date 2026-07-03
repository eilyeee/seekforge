/**
 * Docker reference runner (Track E).
 *
 * The pure core is {@link buildDockerRunArgs}: given a task + workspace + a few
 * isolation knobs, it constructs the full `docker run` argv. It has NO side
 * effects (no spawning, no env mutation, no fs) so it is trivially unit-testable
 * — the pure command construction IS the verification (we never need Docker or a
 * real, paid agent run to check it).
 *
 * The thin impure wrapper {@link spawnDockerRun} just spawns `docker` with those
 * args and streams the child's stdio through.
 *
 * ── Security model ──────────────────────────────────────────────────────────
 * - Isolation: `--rm` (ephemeral container, removed on exit).
 * - Mount scope: exactly ONE read-write bind mount — the workspace → the
 *   container workdir. Nothing else from the host is visible. Because sessions
 *   are written under `<workspace>/.seekforge/sessions`, they persist back to
 *   the host mount and every containerized run is a normal `seekforge audit`
 *   session.
 * - Secret handling: the provider API key is passed by ENV VAR NAME only
 *   (`-e ARK_API_KEY` / `-e DEEPSEEK_API_KEY`, no `=value`). Docker forwards the
 *   host's value at runtime; the secret is NEVER baked into the image or written
 *   into the argv. `buildDockerRunArgs` only ever references the variable name.
 * - Network: a real agent run needs egress to the provider API, so the DEFAULT
 *   is `bridge` (allow egress). The tradeoff: an agent with network can reach
 *   more than just the provider. For fully offline / mocked runs, pass
 *   `network: "none"`. The network is always configurable.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentRunner, RunnerOptions, RunnerResult } from "./runner.js";

/** Default runner image tag (built from the repo `Dockerfile`). */
export const DEFAULT_RUNNER_IMAGE = "seekforge-runner";
/** Default in-container working directory the workspace is mounted at. */
export const DEFAULT_RUNNER_WORKDIR = "/workspace";
/**
 * Default container network. A real agent run must reach the provider API, so
 * we default to `bridge` (egress allowed). Use `none` for offline/mock runs.
 */
export const DEFAULT_RUNNER_NETWORK = "bridge";
/**
 * Provider API-key env vars passed THROUGH to the container by name (never by
 * value). Whichever are present in the host env are forwarded; the container
 * picks the one matching its configured provider.
 */
export const PASSTHROUGH_KEY_ENV_VARS = ["ARK_API_KEY", "DEEPSEEK_API_KEY"] as const;

/** Docker `--network` values we document (any string is still accepted). */
export type DockerNetwork = "none" | "bridge" | "host" | (string & {});

/** Options for {@link buildDockerRunArgs} (pure) and the Docker runner. */
export interface DockerRunnerOptions extends RunnerOptions {
  /** Container network. Default {@link DEFAULT_RUNNER_NETWORK} (`bridge`). */
  network?: DockerNetwork;
  /** `--memory` limit (e.g. `2g`, `512m`). Omitted when unset. */
  memory?: string;
  /** `--cpus` limit (e.g. `1.5`). Omitted when unset. */
  cpus?: string;
  /** In-container workdir / mount target. Default {@link DEFAULT_RUNNER_WORKDIR}. */
  workdir?: string;
  /** Passed to the in-container run as `--permission-mode <mode>` when set. */
  permissionMode?: string;
  /**
   * Env source used ONLY to decide which key vars to forward (by name). The
   * values are never read into the argv. Defaults to `process.env`; tests pass
   * a fixed map for determinism.
   */
  env?: Record<string, string | undefined>;
}

/**
 * PURE: build the full `docker run` argv (starting at `run`, i.e. the args that
 * follow the `docker` binary). No side effects — safe to call in tests and in a
 * `--check` dry-run.
 *
 * Layout:
 *   run --rm --network <net> -v <ws>:<workdir>:rw -w <workdir>
 *   [-e ARK_API_KEY] [-e DEEPSEEK_API_KEY] [--memory <m>] [--cpus <n>]
 *   <image>
 *   seekforge run <task> -y [--max-cost <n>] [-m <model>] [--permission-mode <mode>]
 */
export function buildDockerRunArgs(opts: DockerRunnerOptions): string[] {
  const workspace = path.resolve(opts.workspacePath);
  const workdir = opts.workdir ?? DEFAULT_RUNNER_WORKDIR;
  const image = opts.image ?? DEFAULT_RUNNER_IMAGE;
  const network = opts.network ?? DEFAULT_RUNNER_NETWORK;
  const env = opts.env ?? process.env;

  const args: string[] = [
    "run",
    // Ephemeral: remove the container when it exits.
    "--rm",
    // Isolation: constrained network (default bridge so the provider API is
    // reachable; pass `none` for offline runs).
    "--network",
    network,
    // Single read-write bind mount: the workspace → the container workdir.
    // ":rw" is Docker's default but we state it explicitly for clarity/audit.
    "-v",
    `${workspace}:${workdir}:rw`,
    "-w",
    workdir,
  ];

  // Forward provider API keys BY NAME only. `-e NAME` (no `=value`) tells Docker
  // to pass the host's value at runtime — the secret never touches the argv.
  for (const name of PASSTHROUGH_KEY_ENV_VARS) {
    const val = env[name];
    if (val !== undefined && val !== "") {
      args.push("-e", name);
    }
  }

  // Optional resource limits.
  if (opts.memory) args.push("--memory", opts.memory);
  if (opts.cpus) args.push("--cpus", opts.cpus);

  // The image to run.
  args.push(image);

  // The in-container command: a normal, headless, auto-approved SeekForge run.
  args.push("seekforge", "run", opts.task, "-y");
  if (opts.maxCostUsd !== undefined) args.push("--max-cost", String(opts.maxCostUsd));
  if (opts.model) args.push("-m", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);

  return args;
}

/** Render an argv as a copy-pasteable `docker …` command line (for `--check`). */
export function formatDockerCommand(args: string[]): string {
  const quote = (a: string): string => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a);
  return ["docker", ...args].map(quote).join(" ");
}

/**
 * IMPURE: spawn `docker` with the built args and stream stdio through. Resolves
 * with the child's exit code once it exits. This is the only place that touches
 * the process; the argv it runs comes entirely from {@link buildDockerRunArgs}.
 */
export function spawnDockerRun(opts: DockerRunnerOptions): Promise<RunnerResult> {
  const args = buildDockerRunArgs(opts);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, runner: "docker" });
    });
  });
}

/** The Docker backend as an {@link AgentRunner} (contract-level entry point). */
export function createDockerRunner(): AgentRunner {
  return {
    name: "docker",
    run: (o: RunnerOptions) => spawnDockerRun(o as DockerRunnerOptions),
  };
}
