# Remote / isolated execution (Track E)

> **English** | [简体中文](remote.zh-CN.md)

SeekForge can run the **same task** on your local machine or inside an isolated
environment (a Docker container today; a remote workstation or VM behind the
same contract later). The goal: run risky or long tasks in a sandbox that can
only touch a single workspace, while still producing a normal, auditable
session.

- [The runner contract](#the-runner-contract)
- [The Docker reference runner](#the-docker-reference-runner)
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
streams stdio through. `createDockerRunner()` exposes the backend as an
`AgentRunner`.

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
