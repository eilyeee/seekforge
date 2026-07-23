# 循环模式教程（Auto-Loop）

> [English](loop-tutorial.md) | **简体中文**

> 面向使用者与二次开发者的实操教程。想看架构与不变量约束，读
> [`loop-engineering.zh-CN.md`](./loop-engineering.zh-CN.md)；本文只讲“怎么用、每一步在发生什么、
> 出问题怎么办”。

## 1. 循环模式是什么

普通一次 `run` 是「跑一遍 agent，结束」。**循环模式**在它之上加了一层编排：

```
run → verify → 还没绿？带着失败信息再 run → verify → …  直到通过或触发护栏
```

一句话：**给一个任务和一条“怎样算成功”的命令，让 agent 自己反复改直到那条命令退出码为 0。**

它适合“有明确成功判据、需要多轮试错”的活：

- 把一批失败的测试改绿：`--verify "pnpm test"`
- 修到类型检查通过：`--verify "pnpm typecheck"`
- 修到构建成功：`--verify "cargo build"`
- 修到 lint 干净：`--verify "pnpm lint"`

不适合没有客观判据的活（“把文档写好看点”）——因为循环靠 `verify` 命令的退出码来判断是否结束，没有判据就没有终止条件。

它**不是**什么：

- 不是 `loop.ts` 里那个「一次 run 内部的工具调用循环」。那是单次运行的内循环，本文说的是它**外面**的编排层（`packages/core/src/agent/auto-loop.ts`）。
- 不是 Evolution（那个是提议规则/技能变更给人审）。循环模式只干一件事：把一个任务推到绿。

## 2. 心智模型：一个任务、一个 session、多次迭代

关键设计：**整个循环是同一个 agent session**，每次迭代都 resume 上一次的会话。

- 好处：完整上下文连续，全过程是**一条可审计的 trace**（存在 `.seekforge/sessions/<id>/`）。
- 编排状态（任务、verify 命令、迭代数、累计花费、session id、终态）单独存在
  `.seekforge/loops/<loop-id>.json`，它只**指向**那条 session，不复制对话内容。

三份存储，各管各的：

| 存储 | 路径 | 内容 |
|---|---|---|
| Loop 状态 | `.seekforge/loops/<id>.json` | 编排层**快照**：任务、verify、迭代/预算/花费、终态（每次进展后覆盖写） |
| Loop 日志 | `.seekforge/loops/<id>.log` | 事件流的**追加式** JSONL 历史（每行一个带时间戳的事件，resume 续写同一份） |
| Session trace | `.seekforge/sessions/<id>/` | agent 对话与工具调用的真相来源 |

> 状态 JSON 是快照（只有当前值），Loop 日志是历史（能逐行回放每一轮跑了什么）。两者互补。

## 3. 快速上手（CLI）

最小用法——一个任务 + 一条判据命令：

```bash
seekforge loop "修好 parser 的失败测试，不要削弱断言" --verify "pnpm test"
```

发生的事：

1. 默认 `quick` 模式先做**预检**：运行一次 `pnpm test`，已经是绿的就直接结束，
   不花 agent 迭代。使用 `--requirements analyze` 或 `confirm` 时，会先只读分析仓库并冻结
   结构化需求规格；即使预检为绿，也必须再通过有证据的验收审查。
2. 没绿 → 进入循环：把任务交给 agent 跑一轮（`acceptEdits` 模式，自动应用文件编辑）。
3. 跑完再跑一次 `pnpm test`，实时把输出流式打印出来。
4. 还红 → 把失败信息塞进下一轮 prompt（“`pnpm test` 仍然失败：…，修根因让它通过”），继续。
5. 直到通过，或者撞上护栏（见第 5 节）。

常用参数：

```bash
seekforge loop "<任务>" --verify "<命令>" \
  [--max-iters <n>]     # 最多迭代几轮，默认 8，硬上限 100
  [--budget <usd>]      # 累计花费达到这个数就停
  [--requirements <quick|analyze|confirm>] # 需求分析与验收门禁
  [--worktree [name]]   # 在隔离的 git worktree 里跑（见第 7 节）
  [-y]                  # 只是消掉“会自动批准编辑”的提示，不改变行为
  [-m <model>]          # 覆盖模型
```

> ⚠️ **循环天生是自主的**：每轮都用 `approvalMode: "acceptEdits"`，文件编辑自动批准，
> 不会逐个弹确认。危险命令仍被 denylist 拒绝，工作目录的访问授权仍要过（和 `run` 同一道门）。
> 换句话说：它会自己改你的文件。要么在干净的 git 状态下跑，要么用 `--worktree` 隔离。

`confirm` 会在分析后以 `requirements_pending` 暂停。先用 `loop-show` 查看，
再执行 `seekforge loop-resume <id> --approve-requirements`。批准参数只批准这份已经
持久化的规格，不会静默批准同一次调用里刚生成的需求。

**退出码**：只有 `verify` 通过，且分析模式下所有必需验收标准都满足时才返回 0。
**退出码**：只有 verify 通过且在分析模式下所有必需验收条件都满足时为 `0`。
`requirements_pending` 使用 `2` 表示有意等待批准；失败、取消或耗尽等其它终态使用 `1`。

## 4. 一次迭代内部发生了什么

对照 `auto-loop.ts` 的主循环，每一轮按顺序做这些事：

1. **进入前检查护栏**：收到中止信号→`cancelled`；累计花费已达预算→`budget`。
2. 发 `iteration.start` 事件。
3. **构造 prompt**：第一轮用原始任务；之后用「verify 仍失败 + 结构化诊断 + 输出尾巴 + 修根因」。
4. **跑一轮 agent**（resume 同一 session）。期间：
   - `session.created`：第一次拿到 session id，落盘。
   - `usage.updated`：累计花费实时落盘；**一旦达到预算立刻 abort 当前这轮**（失败的
     run 不发 FinalReport，但它烧的钱也算数，所以在这里就掐，避免反复昂贵失败悄悄超支）。
5. **迭代计数 +1，落盘**，发 `run.completed`（带本轮花费）。
6. **验证**：再跑一次 verify 命令，输出通过 `verify.output` 事件流式吐出。
7. 解析诊断 + 计算工作区指纹，原子落盘，发 `verify` 事件。
8. **退出码 0 且验收完整 → `passed`，收工。** 否则继续检查护栏（见下节）。

> 迭代计数只在 agent run **完成后**才 +1。所以如果在一轮中途崩溃，resume 会重跑这一轮而
> **不消耗**一个迭代额度——同时复用已有 session、并把已观测到的花费算进账。

## 5. 护栏与终态

循环**不会无限跑**。每轮开始前、以及每次验证后，按顺序检查这些停止条件：

| 状态 | 触发条件 |
|---|---|
| `passed` | verify 退出 0，且启用需求分析时验收通过 |
| `requirements_pending` | `confirm` 规格已持久化，等待显式批准 |
| `cancelled` | 收到中止信号（Ctrl-C / Stop 按钮），协作式停止，trace 保留 |
| `budget` | 成本、Token、总时长或校验次数达到配置上限；`budgetReason` 标明具体护栏 |
| `no_progress` | **卡住了**：结构化诊断指纹没变 **且** 工作区内容指纹没变 |
| `exhausted` | 达到 `--max-iters` 上限 |
| `verify_error` | verify 命令根本跑不起来 / 超时 / 在执行器边界失败 |
| `agent_error` | 编辑 Agent 在瞬时错误重试耗尽后仍失败；该失败尝试不会误进校验 |

检查顺序（进入下一轮前）：`aborted` → `budget` → `no_progress`（诊断与工作区都没变）→ `exhausted`。

`no_progress` 是防死循环的核心：光看诊断文本容易被计时、格式噪声骗过，所以它把**结构化诊断
指纹**和**工作区文件内容指纹**配对判断——只要 agent 改了任何文件，就算它没把测试改好，也算
“有进展”，会继续给机会；只有诊断和文件都纹丝不动才判定卡死。

## 6. 验证与诊断解析

`verify` 命令默认通过项目共用的 shell 执行器 + OS 沙箱在工作区里跑，**120 秒超时**，捕获
stdout+stderr 的尾部（约 4 KB）。取消验证会停掉命令并返回 `cancelled`。

失败时，输出会被喂回下一轮 prompt。而且对主流测试框架会做**结构化解析**（`verify-diagnostics.ts`）：

- 支持 **Vitest / Jest / Pytest / Cargo**，自动识别框架。
- 提取失败测试名（去重、有上限）和诊断位置（`文件:行: 消息`）。
- 剥掉计时/格式/ANSI 噪声，只留下稳定的“失败身份”，用来算收敛指纹（判断 `no_progress`）。
- 识别不出框架时退化为原始输出尾巴。

**工作区指纹**：在 git 仓库里，哈希所有改动/暂存/未跟踪文件的完整内容；非 git 工作区则哈希
全部文件。会排除 SeekForge 自己的运行时状态（`.seekforge/loops|sessions|uploads`）。符号链接
按链接本身哈希，绝不跟随到工作区外。

## 7. 隔离运行：`--worktree`

不想让循环直接改你当前的工作目录？用 worktree：

```bash
seekforge loop "<任务>" --verify "pnpm test" --worktree            # 自动取名
seekforge loop "<任务>" --verify "pnpm test" --worktree my-fix     # 指定分支后缀
```

CLI 会新建一个分支（前缀 `seekforge/loop-*`）和对应的 git worktree，然后把那个目录当作循环
的工作区。Loop 状态和 session trace 都存在 worktree 内部。

要点：

- **worktree 不会自动删除**，故意保留给你检查。
- 从 worktree 目录里 `loop-resume` 可以继续。
- 检查完用 `seekforge loop-cleanup <name>` 清理；有脏改动时会拒绝，除非显式 `--force`。
- 只要还有活跃的 lease（循环正在跑），cleanup 一律被拒，`--force` 也不行。

## 8. 恢复（Resume）

任何终态的循环都能显式 resume——但 resume 会先跑一次**全新预检**，可能直接就绿了：

```bash
seekforge loop-resume <loop-id> [--approve-requirements] [--add-iters <n>] [--add-budget <usd>]
```

- resume 只从你给的工作区加载状态，保留原任务、verify 命令、最大迭代、累计花费、session id。
- 已经耗尽迭代/预算的终态循环，resume 后**只能靠预检通过**——否则同一条护栏会立刻再次拦住它，
  不会白花 agent 迭代。
- `--add-iters`：加到已存最大值上，硬顶 100。
- `--add-budget`：在已存预算上叠加；若原本没预算，则从**已花费**起算，历史花费永不清零。结果
  预算必须有限，数值溢出会被拒绝（而不是当成“没有预算”）。

管理命令：

```bash
seekforge loop-list                    # 列出所有持久化的循环
seekforge loop-show <loop-id>          # 看单个循环的状态
seekforge loop-delete <loop-id>        # 删除持久化状态
seekforge loop-cleanup <name> [--force] # 清理 worktree
```

从基础检出目录运行这些管理命令时，会自动发现保留 worktree 里的循环状态。同一个 loop id 在多个
工作区里出现会被判为**歧义**并拒绝，而不是随便挑一个。管理命令在非 git 目录下也能用；旧版本存
的路径会被规范化到物理路径，让符号链接/平台路径别名解析到同一份状态。

## 9. 崩溃恢复、锁与持久化（原理）

这部分你不需要手动管，但了解一下有助于排查：

- **原子写入**：状态在“可观测进展”后原子落盘（写临时文件再 rename）。所以崩溃不会留下半截状态。
- **独占租约（lease）**：同一个持久化循环同一时刻只能被一个进程拥有。状态文件旁有个 token 保护的
  锁，记录 owner 的进程身份和 PID，拒绝并发运行；进程退出或 PID 复用后能回收锁。刚写坏的锁在短暂
  宽限期内 fail-closed，防止半写的锁被别人抢走。
- **持久化失败降级**：落盘失败只报一次 `loop.warning`，不会顶替掉验证结果本身。
- **合并 checkpoint**：session id 与累计成本、Token、时长最多合并 250ms 再原子写入；迭代和终态
  边界强制刷新，减少写放大且不丢失已完成状态。
- **有界事件日志**：每个 `LoopEvent`（迭代开始、run 花费、流式验证输出、通过/失败、汇总）都
  以 JSONL 批量追加进 `.seekforge/loops/<id>.log`；每 4 MiB 轮转，保留当前文件和两个旧分段。
  这是**尽力而为的可观测记录**：写日志失败会被吞掉、
  绝不打断循环（真正坏掉的目录会通过上面的持久化告警暴露）。`persist: false` 时不写日志；`loop-delete`
  会连同状态一起删掉它。日志文件在 `.seekforge/loops/` 前缀内，不参与工作区指纹，因此不会干扰
  `no_progress` 判断。

看日志的方式：

```bash
tail -f .seekforge/loops/<loop-id>.log        # 实时跟一个正在跑的循环
cat .seekforge/loops/<loop-id>.log | jq .      # 结构化回放（每行一个事件）
```

CLI 每次循环结束的汇总里也会打印这条日志的路径。

## 10. 桌面端 / TUI 用法

**桌面端**：聊天窗口顶部有个可折叠的 **Loop 面板**——任务 + verify 命令输入框、最大迭代 + 预算、
一个 Run/Stop 按钮。进度实时流式显示：每轮一行（本轮花费 + 实时验证输出 + 通过/失败），结束时给
一段状态汇总和 loop id。工具栏里的模型/思考档位会一起带上，和普通 run 一样。断线时运行会被标记为
中断，挂起的确认框清空，排给失败连接的请求丢弃而不是重连后重放。

**TUI**：`/loop` 用多行命令——第一行是循环选项 + verify 命令，后面几行是任务：

```text
/loop --requirements analyze --max-iterations 12 --budget 1.50 pnpm test
修好失败的 parser 测试，不要削弱断言。
```

`--requirements` 接受 `quick|analyze|confirm`；`--max-iterations` 接受 1–100；
`--budget` 必须是有限正数 USD，会覆盖配置里的值。不给预算就继承配置默认。默认迭代上限 8。
TUI 恢复：`/loop-resume [--approve-requirements] [--add-iterations N] [--add-budget USD] <loop-id>`。

## 11. Core API（二次开发）

从 `@seekforge/core` 引入 `runAutoLoop` / `resumeAutoLoop`：

```ts
import { runAutoLoop } from "@seekforge/core";

const result = await runAutoLoop(deps, {
  task: "修好失败的测试",
  workspace: "/abs/path/to/project",   // 必须是绝对路径
  verifyCommand: "pnpm test",           // 退出 0 == 成功
  maxIterations: 8,                     // 默认 8，硬顶 100
  costBudgetUsd: 2.0,                   // 累计观测花费达到就停（可选）
  tokenBudget: 200_000,                 // prompt + completion Token
  maxDurationMs: 30 * 60_000,           // 可跨恢复累计的总时长
  maxVerifyRuns: 12,                    // 包含首次预检查
  verifyTimeoutMs: 120_000,
  agentTimeoutMs: 30 * 60_000,
  maxAgentRetries: 1,
  approvalMode: "acceptEdits",          // 默认就是它
  signal: controller.signal,            // 协作式中止（可选）
  onEvent: (e) => { /* iteration.start | run.completed | verify.output | verify | loop.warning | loop.done */ },
  // verify: 可注入自定义验证器（测试用），默认走真实 shell 执行 + 沙箱
});

// result.status 还包括 "requirements_pending" 和 "agent_error"
// result.iterations / result.costUsd / result.sessionId / result.finalVerify / result.loopId
```

事件流类型（`LoopEvent`）：

- `iteration.start` — 第 n 轮开始
- `run.completed` — 第 n 轮 agent 跑完，带累计花费
- `verify.output` — 验证命令的流式输出块（每次验证有事件数和块大小上限）
- `verify` — 验证结果（退出码 + 是否通过 + 输出尾巴）
- `loop.warning` — 持久化、需求或观察回调被禁用告警
- `loop.done` — 最终 `LoopResult`

`resumeAutoLoop` 会恢复 worker/reviewer 会话和累计资源用量，并可追加迭代、成本、Token、
时长及校验次数额度。

## 12. 实践建议与 FAQ

**verify 命令怎么选？** 越快越好、越确定越好。它每轮都要跑，慢命令直接拖慢整个循环，还容易撞
120 秒超时。能只跑相关子集就别跑全量（比如只跑改动涉及的测试文件）。

**为什么它跑了几轮就说 `no_progress`？** agent 连续两轮既没改出不同的诊断、也没动任何文件——
判定卡死。通常意味着任务描述不够具体，或者根因超出 agent 能力。把任务写得更明确、或换更强的
模型（`-m`）再 resume。

**为什么 `verify_error`？** verify 命令根本没跑起来——命令名拼错、依赖没装、超时。终态输出里带
着 stdout/stderr 诊断，照着排。

**会不会烧很多钱？** 会。务必设 `--budget`。预算是在每次用量更新后检查的硬线，达到就掐掉在途
请求；但已经发出的那一个请求可能让最终账单略微超一点。

**怎么中途停？** Ctrl-C（CLI）或 Stop 按钮（桌面）。协作式停止，状态 `cancelled`，trace 保留，
之后能 `loop-resume`。再按一次 Ctrl-C 强制退出。

**它改乱了怎么办？** 因为是同一条 git 工作区，直接 `git restore` / `git checkout` 回退即可；这也
正是推荐 `--worktree` 隔离、或在干净 git 状态下跑的原因。

**和普通 run/session 的关系？** 循环复用 `runTask` + session resume + 同一套权限模型；验证复用
`run_command` 的 shell 执行器和 OS 沙箱；也复用 `escalateOnFailure`（失败的 run 交给 planModel）。
整个循环是**一条 session**，随时能用 session 级的 `resume` / `rewind` 手动介入。
