/**
 * SSH runner backend (Track E: remote / isolated execution).
 *
 * The second implementation of the {@link AgentRunner} contract, and the one it
 * was written for: run the same task on a machine you own — the workstation
 * with the big CPU, the box that can reach the staging database — and get back
 * a normal, auditable session. No service, no scheduler, no account: one host,
 * your own SSH key, a workspace that already exists there.
 *
 * Two decisions define its security posture, and both are deliberate.
 *
 * **The API key is never transmitted.** Docker can forward a secret by NAME
 * because the container shares the host's environment; SSH cannot — forwarding
 * would mean putting the key on the wire, into the remote environment, and
 * usually into that host's shell history. The remote host must already have its
 * own credentials configured, exactly as it would if a person logged in and ran
 * SeekForge by hand. A machine you cannot trust with its own key is not a
 * machine to hand a coding agent.
 *
 * **Every interpolated value is quoted for the remote shell.** ssh always runs
 * its command through the login shell there, so the task text — free-form
 * prose, frequently containing quotes and backticks — is shell input whether we
 * like it or not. It is single-quoted, with embedded quotes escaped, and
 * `buildSshRunArgs` is pure so the exact command can be inspected with
 * `--check` before anything runs.
 */

import { spawn } from "node:child_process";
import { formatCommandLine, shellQuote } from "./runner.js";
import type { AgentRunner, RunnerOptions, RunnerResult } from "./runner.js";

/** Remote SeekForge binary, assumed on the remote PATH unless overridden. */
export const DEFAULT_REMOTE_BINARY = "seekforge";

export interface SshRunnerOptions extends RunnerOptions {
  /** `user@host` (or an ssh_config host alias). Required. */
  host: string;
  /** Remote SSH port. Omitted when unset, so ssh_config decides. */
  port?: number;
  /** Private key file, passed as `-i`. Omitted when unset (ssh-agent / ssh_config decide). */
  identityFile?: string;
  /** Remote SeekForge binary. Default {@link DEFAULT_REMOTE_BINARY}. */
  binary?: string;
  /** Passed to the remote run as `--permission-mode <mode>` when set. */
  permissionMode?: string;
}

/**
 * PURE: build the full `ssh` argv (the args that follow the `ssh` binary).
 *
 * Layout:
 *   [-p <port>] [-i <identity>] -o BatchMode=yes -o RequestTTY=no <host>
 *   cd <workspace> && <binary> run <task> -y [--max-cost n] [-m model]
 *   [--permission-mode mode]
 */
export function buildSshRunArgs(opts: SshRunnerOptions): string[] {
  if (!opts.host.trim()) throw new Error("ssh runner requires a host");
  // The workspace is a REMOTE path: nothing here can resolve or verify it, and
  // silently rewriting it against the local filesystem would send the agent
  // somewhere the caller never named.
  if (!opts.workspacePath.startsWith("/")) {
    throw new Error("ssh runner requires an absolute remote workspace path");
  }

  const args: string[] = [];
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65_535) {
      throw new Error(`ssh runner port must be an integer between 1 and 65535: ${opts.port}`);
    }
    args.push("-p", String(opts.port));
  }
  if (opts.identityFile) args.push("-i", opts.identityFile);
  args.push(
    // Fail instead of blocking on a password prompt: this runs unattended, and
    // a hung prompt looks exactly like a slow task.
    "-o",
    "BatchMode=yes",
    // No TTY, no agent forwarding, no X11. A remote agent run needs none of
    // them, and agent forwarding in particular would hand the remote host the
    // ability to use every key in the local agent.
    "-o",
    "RequestTTY=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    opts.host,
  );

  const binary = opts.binary ?? DEFAULT_REMOTE_BINARY;
  const remote = ["cd", shellQuote(opts.workspacePath), "&&", shellQuote(binary), "run", shellQuote(opts.task), "-y"];
  if (opts.maxCostUsd !== undefined) remote.push("--max-cost", shellQuote(String(opts.maxCostUsd)));
  if (opts.model) remote.push("-m", shellQuote(opts.model));
  if (opts.provider) remote.push("--provider", shellQuote(opts.provider));
  if (opts.permissionMode) remote.push("--permission-mode", shellQuote(opts.permissionMode));
  // One argument: ssh concatenates multiple ones with spaces anyway, and
  // joining here keeps what the remote shell receives visible in the argv.
  args.push(remote.join(" "));
  return args;
}

/** Render an argv as a copy-pasteable `ssh …` command line (for `--check`). */
export function formatSshCommand(args: string[]): string {
  return formatCommandLine("ssh", args);
}

export function spawnSshRun(opts: SshRunnerOptions): Promise<RunnerResult> {
  const args = buildSshRunArgs(opts);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, runner: "ssh" });
    });
  });
}

/** The SSH backend as an {@link AgentRunner} (contract-level entry point). */
export function createSshRunner(): AgentRunner {
  return {
    name: "ssh",
    run: (o: RunnerOptions) => spawnSshRun(o as SshRunnerOptions),
  };
}
