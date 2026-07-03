/**
 * `seekforge sandbox-run <task>` — execute a task inside an isolated Docker
 * container against the current workspace (Track E: remote / isolated
 * execution). See `docs/remote.md` for the security model.
 *
 * The argv is built by the PURE {@link buildDockerRunArgs}; this command is the
 * thin impure shell around it. `--check` prints the exact `docker …` command
 * without running anything (no Docker, no spend) — the inspectable, testable
 * dry-run.
 */

import path from "node:path";
import { fail } from "../colors.js";
import {
  buildDockerRunArgs,
  DEFAULT_RUNNER_IMAGE,
  DEFAULT_RUNNER_NETWORK,
  formatDockerCommand,
  spawnDockerRun,
  type DockerNetwork,
} from "../docker-runner.js";

export type SandboxRunOptions = {
  image?: string;
  network?: string;
  memory?: string;
  cpus?: string;
  model?: string;
  maxCost?: number;
  permissionMode?: string;
  /** Print the docker argv and exit without spawning (dry-run). */
  check?: boolean;
};

export async function sandboxRunCommand(task: string, opts: SandboxRunOptions): Promise<void> {
  const workspacePath = path.resolve(process.cwd());
  const dockerOpts = {
    task,
    workspacePath,
    image: opts.image ?? DEFAULT_RUNNER_IMAGE,
    network: (opts.network ?? DEFAULT_RUNNER_NETWORK) as DockerNetwork,
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxCost !== undefined ? { maxCostUsd: opts.maxCost } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  };

  // --check: dry-run. Print the exact command; never spawn docker (no spend).
  if (opts.check) {
    console.log(formatDockerCommand(buildDockerRunArgs(dockerOpts)));
    return;
  }

  try {
    const result = await spawnDockerRun(dockerOpts);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`docker run failed: ${msg}`, {
      hint: "Is Docker installed and running? Build the image first: docker build -t seekforge-runner .",
    });
  }
}
