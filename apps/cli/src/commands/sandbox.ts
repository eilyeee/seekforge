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
import { buildSshRunArgs, formatSshCommand, spawnSshRun, type SshRunnerOptions } from "../ssh-runner.js";

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

export type RemoteRunOptions = {
  host: string;
  workspace: string;
  port?: number;
  identity?: string;
  binary?: string;
  model?: string;
  provider?: string;
  maxCost?: number;
  permissionMode?: string;
  /** Print the ssh argv and exit without connecting (dry-run). */
  check?: boolean;
};

/**
 * `seekforge remote-run <task> --host <user@host> --workspace <remote path>` —
 * run one task on a machine you own.
 *
 * The workspace path is REMOTE and cannot be checked from here, which is why it
 * must be absolute and why `--check` prints the exact command first. The remote
 * host uses its OWN provider credentials: nothing about a key is sent.
 */
export async function remoteRunCommand(task: string, opts: RemoteRunOptions): Promise<void> {
  const sshOpts: SshRunnerOptions = {
    task,
    host: opts.host,
    workspacePath: opts.workspace,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.identity ? { identityFile: opts.identity } : {}),
    ...(opts.binary ? { binary: opts.binary } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.maxCost !== undefined ? { maxCostUsd: opts.maxCost } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  };

  let args: string[];
  try {
    args = buildSshRunArgs(sshOpts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), {
      hint: "remote-run needs --host and an absolute --workspace path on that host",
    });
    return;
  }

  if (opts.check) {
    console.log(formatSshCommand(args));
    return;
  }

  try {
    const result = await spawnSshRun(sshOpts);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`ssh run failed: ${msg}`, {
      hint: "Check that ssh reaches the host non-interactively and that SeekForge is installed there with its own API key.",
    });
  }
}
