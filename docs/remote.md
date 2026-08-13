# Remote / isolated execution (Track E)

> **English** | [简体中文](remote.zh-CN.md)

SeekForge can run the **same task** on your local machine or inside an isolated
environment (a Docker container today; a remote workstation or VM behind the
same contract later). The goal: run risky or long tasks in a sandbox that can
only touch a single workspace, while still producing a normal, auditable
session.

- [The runner contract](#the-runner-contract)
- [The Docker reference runner](#the-docker-reference-runner)
- [The SSH runner](#the-ssh-runner)
- [Building the runner image](#building-the-runner-image)
- [Running a task in a container](#running-a-task-in-a-container)
- [Security model](#security-model)
- [Auditing containerized runs](#auditing-containerized-runs)

## The runner contract

A *runner* is anything that can execute one task against a workspace and produce
a session. The contract lives in
[`apps/cli/src/runner.ts`](../apps/cli/src/runner.ts):

```ts
interface RunnerOptions {
  task: string;          // what to do
  workspacePath: string; // the ONLY directory the runner may touch (absolute)
  model?: string;        // override the model
  provider?: string;     // deepseek | ark (else config decides)
  mode?: "ask" | "edit"; // read-only Q&A vs. can write / run commands
  maxCostUsd?: number;   // per-run cost cap
  image?: string;        // runner image / identifier
}

interface RunnerResult {
  sessionId?: string; // for `seekforge audit`
  exitCode: number;   // 0 = success
  runner: string;     // which backend produced this (e.g. "docker")
}

interface AgentRunner {
  readonly name: string;
  run(opts: RunnerOptions): Promise<RunnerResult>;
}
```

Backends map `RunnerOptions` onto their own launch mechanism. Backend-specific
knobs (Docker's `--network`, `--memory`, `--cpus`) extend `RunnerOptions` in the
backend's own option type rather than bloating the shared contract.

## The Docker reference runner

The Docker backend lives in
[`apps/cli/src/docker-runner.ts`](../apps/cli/src/docker-runner.ts). Its core is
a **pure** function, `buildDockerRunArgs(opts)`, that constructs the full
`docker run` argv with no side effects — so it is fully unit-testable without
Docker and without spending anything on a real run.

The argv it builds:

```
docker run --rm --network <net> \
  -v <workspace>:/workspace:rw -w /workspace \
  [-e ARK_API_KEY] [-e DEEPSEEK_API_KEY] \
  [--memory <m>] [--cpus <n>] \
  <image> \
  seekforge run "<task>" -y [--max-cost <n>] [-m <model>] [--permission-mode <mode>]
```

A thin impure wrapper (`spawnDockerRun`) spawns `docker` with those args and
streams stdio through, and that is the entry point `sandbox-run` calls — the ssh
backend mirrors it with `spawnSshRun`. Both share `RunnerOptions`/`RunnerResult`
and the shell quoting in `runner.ts`; there is no separate runner-object
factory.

## The SSH runner

The second backend, in
[`apps/cli/src/ssh-runner.ts`](../apps/cli/src/ssh-runner.ts), runs the same
task on **a machine you own** — the workstation with the big CPU, the box that
can reach staging. No service, no scheduler, no account: one host, your ssh key,
a workspace that already exists there.

```sh
# Print the exact ssh command WITHOUT connecting (no run, no spend):
seekforge remote-run "run the full suite" \
  --host dev@build-box --workspace /srv/repo --check

# Actually run it:
seekforge remote-run "fix the failing test" \
  --host dev@build-box --workspace /srv/repo --max-cost 2
```

`--workspace` is a path **on the remote host** and must be absolute: nothing
here can resolve or verify it, and resolving it locally would silently send the
agent somewhere you never named. `--check` prints the command first for exactly
that reason.

Three optional flags describe the remote side, and all three appear in
`--check` output before anything connects:

| Flag | Effect |
| --- | --- |
| `--identity <file>` | ssh private key to authenticate with. Without it, ssh-agent and your `ssh_config` decide, as they would for a plain `ssh`. |
| `--binary <path>` | Where `seekforge` lives on the remote host. Default: whatever `seekforge` resolves to on the remote `PATH`. |
| `--provider <name>` | Overrides the provider for the remote run only. The remote host uses **its own** API key either way — see below. |

### What it does not send

**Your API key never leaves this machine.** Docker can forward a secret by NAME
because the container shares the host's environment; ssh cannot — forwarding
would put the key on the wire, into the remote environment, and usually into
that host's shell history. The remote host must already have its own
credentials, exactly as it would if you logged in and ran SeekForge by hand. A
machine you would not trust with its own key is not one to hand a coding agent.

The connection is also deliberately narrow: `BatchMode=yes` (fail instead of
blocking on a password prompt, since this runs unattended), no TTY, no X11, and
**no agent forwarding** — which would otherwise hand the remote host the use of
every key in your local ssh-agent.

### Quoting

ssh always runs its command through the remote login shell, so the task text —
free-form prose, routinely containing quotes and backticks — is shell input
whether anyone wants it to be. Every interpolated value is single-quoted with
embedded quotes escaped, and `buildSshRunArgs` is pure, so what the remote shell
receives is exactly what `--check` shows you.

## Building the runner image

The image is built from the repo [`Dockerfile`](../Dockerfile). Build it
yourself — it is **not** built in CI or tests:

```sh
docker build -t seekforge-runner .
```

By default the image installs the published `seekforge` from npm on a
`node:20-slim` base. To bake in a **local** build instead:

```sh
pnpm --filter seekforge build
cd apps/cli && npm pack           # produces seekforge-<version>.tgz
# then edit the Dockerfile to COPY + `npm i -g ./seekforge-<version>.tgz`
```

## Running a task in a container

```sh
# Inspect the exact docker command WITHOUT running it (no Docker, no spend):
seekforge sandbox-run "fix the failing test" --check

# Actually run it (requires Docker + the built image + a key in your env):
ARK_API_KEY=...  seekforge sandbox-run "fix the failing test"

# Constrain resources / network:
seekforge sandbox-run "run the test suite" \
  --network none --memory 2g --cpus 1.5 --max-cost 0.50
```

Flags: `--image`, `--network none|bridge|host`, `--memory`, `--cpus`,
`-m/--model`, `--permission-mode`, `--max-cost`, and `--check` (dry-run). The
command builds its argv via `buildDockerRunArgs` and execs `docker`; `--check`
prints the argv and exits, so you can inspect exactly what would run.

## As a Graph executor

Both runners can back a `remote` node in an [Engineering Graph](graph-engineering.md).
Registration lives in **`~/.seekforge/graph-executors.json`** — the operator's home
directory, never the workspace:

```json
{
  "version": 1,
  "executors": {
    "sandbox": { "runner": "docker", "image": "seekforge-runner", "workspaceCapacity": 2 },
    "workstation": { "runner": "ssh", "host": "me@build-box", "workspace": "/srv/repo" }
  }
}
```

Docker entries accept `image`, `network`, `memory`, `cpus`, and `workdir`; ssh
entries accept `host`, `workspace`, `port`, `identityFile`, `binary`, `provider`,
and `model`. Both accept `capacity` and `workspaceCapacity`.

**Why home-only.** A workspace file would let a cloned repository name an
attacker's host and hand `seekforge graph run` both the task text and an agent.
Registration is an operator act, so it comes from the operator's home directory.
Without the file there is no adapter and every `remote` node fails preflight;
a malformed file throws rather than degrading to an empty registry. Plugin
manifests can still only *alias* an id the host already registered — they cannot
create trust.

Capabilities are declared only where they are real:

| | docker | ssh |
| --- | --- | --- |
| Capacity reservation / fencing | container named `seekforge-graph-<hash>`; the daemon's refusal to reuse a live name *is* the fence | none — a token that fences nothing is worse than no token |
| Cooperative cancellation | yes (`docker kill` stops the container) | **no** — killing the local `ssh` closes the channel, and whether the remote run dies is that host's sshd's decision. A node with `requiresCancellation: true` is refused at preflight on an ssh executor |
| Result provenance | yes — the claimed `session_id` must exist under the mounted workspace | none (the session lives on the remote host) |
| Recovery by idempotency key | yes — journal at `.seekforge/graph-remote-results/` (bounded to 256 entries) | same |

**Cost.** Usage is not invisible over ssh: `seekforge run --output-format json`
prints a result envelope with `session_id`, `total_cost_usd`, and `usage`, and
that envelope returns over the same channel that carried the command. What
differs is *attribution*, not measurability — the remote host bills its own key —
so each node result records `costAccount: "remote"` or `"local"`, and the cost is
still charged to the Graph ledger because it really was spent running this Graph.
The Graph's remaining `costBudgetUsd` is pushed down as `--max-cost`, so the
budget is enforced on the remote host as well as observed locally.

Where no usage is reported at all, the node **fails non-retryably** if the Graph
declared a cost or token budget — retrying would spend the same unmeasured amount
again. Without a budget it records `costUsd: 0` together with
`costAccounting: "unreported"`, so nothing downstream can read that zero as a
measurement.

**Operational notes.** Give remote nodes a `timeoutMs`: the run gets `-y`, but an
env-level permission prompt on a closed stdin has no human to answer it, and only
the node timeout bounds that. Graph containers are visible under the
`seekforge-graph-` name prefix in `docker ps`.

## Security model

- **Isolation.** `--rm` — the container is ephemeral and removed on exit.
- **Single-workspace mount.** Exactly one read-write bind mount: your workspace →
  `/workspace`. Nothing else from the host is visible inside the container. The
  agent cannot reach files outside the workspace.
- **Secrets via env, never baked in.** The provider API key is passed by
  **env-var NAME only** (`-e ARK_API_KEY` / `-e DEEPSEEK_API_KEY`, no
  `=value`). Docker forwards the host's value at runtime. The key is never
  written into the image and never appears in the `docker` argv — `--check`
  output is safe to paste anywhere. `buildDockerRunArgs` only references the
  variable name; whichever key vars are set in your env are forwarded.
- **Network tradeoff.** A real agent run needs egress to the provider API, so the
  network defaults to `bridge` (egress allowed). The tradeoff is that an agent
  with network can reach more than just the provider endpoint. For fully offline
  or mocked runs, pass `--network none`. `--network host` is available but drops
  network isolation — avoid it unless you need it.
- **Resource limits.** Optional `--memory` and `--cpus` cap what a runaway task
  can consume.
- **Cost cap.** `--max-cost` bounds spend inside the container just like a local
  run.

## Auditing containerized runs

A containerized run is a **normal SeekForge session**. Sessions are written under
`<workspace>/.seekforge/sessions/<id>/`, and because the workspace is a
read-write mount, they persist back to the host after the container exits. So
everything the sandboxed agent did is inspectable from the host with the usual
tools:

```sh
seekforge sessions        # list sessions (incl. those produced in a container)
seekforge audit <id>      # full audit trail for a containerized run
```
