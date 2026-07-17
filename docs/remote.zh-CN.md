# 远程 / 隔离执行（Track E）

> [English](remote.md) | **简体中文**

SeekForge 可以将**同一个任务**运行在你的本地机器上，或运行在隔离环境中（今天是 Docker 容器；未来是遵循同一契约的远程工作站或 VM）。目标：把有风险或耗时长的任务放进只能触及单个工作区的沙箱里运行，同时仍然产出一个正常的、可审计的会话。

- [Runner 契约](#runner-契约)
- [Docker 参考 runner](#docker-参考-runner)
- [构建 runner 镜像](#构建-runner-镜像)
- [在容器中运行任务](#在容器中运行任务)
- [安全模型](#安全模型)
- [审计容器化运行](#审计容器化运行)

## Runner 契约

*Runner* 是任何能针对一个工作区执行一个任务并产出一个会话的东西。契约位于
[`apps/cli/src/runner.ts`](../apps/cli/src/runner.ts)：

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

各后端将 `RunnerOptions` 映射到自己的启动机制。后端特有的选项（Docker 的 `--network`、`--memory`、`--cpus`）在后端自己的选项类型中扩展 `RunnerOptions`，而不是让共享契约膨胀。

## Docker 参考 runner

Docker 后端位于
[`apps/cli/src/docker-runner.ts`](../apps/cli/src/docker-runner.ts)。其核心是一个**纯**函数 `buildDockerRunArgs(opts)`，它无副作用地构造完整的 `docker run` argv——因此不需要 Docker、也不用为真实运行花一分钱，就能完整地做单元测试。

它构造的 argv：

```
docker run --rm --network <net> \
  -v <workspace>:/workspace:rw -w /workspace \
  [-e ARK_API_KEY] [-e DEEPSEEK_API_KEY] \
  [--memory <m>] [--cpus <n>] \
  <image> \
  seekforge run "<task>" -y [--max-cost <n>] [-m <model>] [--permission-mode <mode>]
```

一个轻薄的非纯包装（`spawnDockerRun`）用这些参数启动 `docker` 并透传 stdio。`createDockerRunner()` 将该后端以 `AgentRunner` 形式暴露。

## 构建 runner 镜像

镜像由仓库中的 [`Dockerfile`](../Dockerfile) 构建。请自行构建——CI 和测试中**不会**构建它：

```sh
docker build -t seekforge-runner .
```

默认情况下，镜像在 `node:20-slim` 基础上安装 npm 上已发布的 `seekforge`。若要改为打入**本地**构建：

```sh
pnpm --filter seekforge build
cd apps/cli && npm pack           # produces seekforge-<version>.tgz
# then edit the Dockerfile to COPY + `npm i -g ./seekforge-<version>.tgz`
```

## 在容器中运行任务

```sh
# Inspect the exact docker command WITHOUT running it (no Docker, no spend):
seekforge sandbox-run "fix the failing test" --check

# Actually run it (requires Docker + the built image + a key in your env):
ARK_API_KEY=...  seekforge sandbox-run "fix the failing test"

# Constrain resources / network:
seekforge sandbox-run "run the test suite" \
  --network none --memory 2g --cpus 1.5 --max-cost 0.50
```

Flag：`--image`、`--network none|bridge|host`、`--memory`、`--cpus`、`-m/--model`、`--permission-mode`、`--max-cost`，以及 `--check`（dry-run）。该命令通过 `buildDockerRunArgs` 构造 argv 并 exec `docker`；`--check` 打印 argv 后退出，让你可以精确检查将要运行的内容。

## 安全模型

- **隔离。** `--rm`——容器是短暂的，退出即删除。
- **单工作区挂载。** 有且只有一个读写 bind mount：你的工作区 →
  `/workspace`。宿主机上的其他任何东西在容器内都不可见。
  智能体无法触及工作区之外的文件。
- **密钥经环境变量传递，绝不打入镜像。** provider API 密钥只以
  **环境变量名**传递（`-e ARK_API_KEY` / `-e DEEPSEEK_API_KEY`，
  没有 `=value`）。Docker 在运行时转发宿主机的值。密钥绝不会写入镜像，
  也绝不出现在 `docker` argv 中——`--check` 的输出可以安全地粘贴到任何地方。
  `buildDockerRunArgs` 只引用变量名；你环境中设置了哪些密钥变量，
  就转发哪些。
- **网络权衡。** 真实的智能体运行需要对 provider API 的出站流量，
  因此网络默认为 `bridge`（允许出站）。代价是拥有网络的智能体
  能触及的不止 provider 端点。要做完全离线或 mock 运行，
  传 `--network none`。`--network host` 可用，但会放弃网络隔离——
  非必要不使用。
- **资源限制。** 可选的 `--memory` 与 `--cpus` 限制失控任务能消耗的资源。
- **成本上限。** `--max-cost` 像本地运行一样限制容器内的花费。

## 审计容器化运行

容器化运行就是一个**正常的 SeekForge 会话**。会话写在 `<workspace>/.seekforge/sessions/<id>/` 下，而由于工作区是读写挂载，它们在容器退出后会持久化回宿主机。因此沙箱内智能体做的一切，都可以在宿主机上用常规工具检查：

```sh
seekforge sessions        # list sessions (incl. those produced in a container)
seekforge audit <id>      # full audit trail for a containerized run
```
