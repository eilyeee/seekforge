# 评测（Evals）与回归门禁

> [English](EVALS.md) | **简体中文**

有两层机制防止回归：

1. **确定性 CI 门禁**（`.github/workflows/ci.yml`，每次 push/PR 都运行）：
   `pnpm -r typecheck`、`pnpm -r build`、`pnpm -r test`，外加 `cargo check`/`test`
   （桌面端 shell crate 被排除 —— 它需要先构建好前端）。这一层覆盖全部
   单元/契约/安全测试；不需要 API key，是日常的安全网。
2. **持续 Agent 评测**（`.github/workflows/eval.yml`，手动触发 + 每周一次）——
   通过配置好的 provider API 让 agent 跑真实任务。每周的 `nightly` 套件对每个
   任务采样三次，并对质量、成本、token 用量、工具失败、会话错误以及
   pass→fail 回归设卡。因为它花钱且不确定，所以**不在** PR 门禁上。

确定性门禁还会运行范围明确的 `test:coverage:critical`、
`test:coverage:security`、`test:coverage:protocol`、`test:coverage:ws` 与
`test:coverage:server`。它们共同覆盖高风险的 URL/浏览器/命令/缓存、
权限/沙箱/Agent Loop、共享帧协议、Server WebSocket、运行账本和触发器边界。
这些数字是回归底线，并不表示单一的全仓库覆盖率百分比能够衡量质量。

## 在本地运行评测

```sh
# Needs a key; without one the harness prints a skip and exits 0.
export DEEPSEEK_API_KEY=sk-...
pnpm --filter @seekforge/eval-harness eval                          # full task set
pnpm --filter @seekforge/eval-harness eval -- --task add-function   # one task
pnpm --filter @seekforge/eval-harness eval -- --task a,b,c          # a subset (comma list)
pnpm --filter @seekforge/eval-harness eval -- --suite smoke         # fast representative set
pnpm --filter @seekforge/eval-harness eval -- --suite nightly       # all tasks, 3 samples each
pnpm --filter @seekforge/eval-harness eval -- --suite release       # all tasks, 5 samples each
```

常用 flag（见 `src/cli.ts`）：`--task <id|id,id,...>`（单个 id 或逗号分隔的子集）、
`--baseline <file>`、`--fail-on-regression`、`--suite <name>`、`--repeat <n>`、
`--junit <file>`、`--require-api-key`、`--variant <name>`、`--ab <a,b>`、
`--skill-ranking`、`--keep` 和 `--list-variants`。`--repeat` 接受 1 到 20 次采样，
并覆盖套件默认值；`--task` 用于收窄所选套件。每次运行都会在 `evals/reports/`
下写出带时间戳的 Markdown 和 JSON；`--junit` 会额外写出 JUnit XML。
既有 flag 和单采样报告字段保持兼容。`--ab` 接受相同的 `--repeat` 次数：
每个 `(task, sample)` 是严格配对，执行顺序按 A→B、B→A 交替，
以减少 provider 顺序和时间漂移带来的偏差。

### 套件与指标

`evals/config.json` 是纳入版本管理的套件定义与门禁策略：

- `smoke`：十四个有代表性的导航、编辑、验证、策略、恢复、记忆、dogfood、
  Python 和 TypeScript 任务；默认采样一次。
- `nightly`：全部 62 个任务；默认采样三次。
- `release`：全部 62 个任务；采样五次，门禁更严格。

每次采样都会记录 prompt、completion、缓存命中和总 token 数（包括失败会话
终止前最后一次上报的累计用量）；工具调用数和失败的工具调用数；会话错误；
时长；成本；确定性检查结果；以及既有的启发式会话评分。报告会聚合成功率、
工具失败率、会话错误率、单次成功成本（cost per success）和单次成功 token 数。
配对 A/B 报告还额外包含每个实验臂成功率的 Wilson 95% 置信区间、
决定性配对胜率，以及成本的最小值/四分位/p95/最大值和平均采样成本的
95% 置信区间。

JSON 报告保留历史的 `{ generatedAt, results }` 字段，并新增 `metadata`、
`aggregate` 和 `gates`。metadata 标识 provider、模型、变体、套件、重复次数、
Git SHA、数据集 SHA-256、Node 版本和平台。这样既不破坏旧的报告读取方，
又让一次运行可复现。

每次标准或 A/B 运行之后，harness 会根据所有有效的带时间戳报告 JSON 重建
`evals/reports/trends.json` 和 `evals/reports/trends.md`。格式错误或不兼容的
历史文件会被跳过，而不会污染当前运行。

### Runner 模式

没有 `runner` 字段的任务保持历史的单会话 `agent` 行为。支持三种 runner 值：

- `agent`：一次 `AgentCore.runTask` 调用。可选的 `expectedStatus` 为
  `completed`（默认）或 `failed`。
- `loop`：真实的核心 `runAutoLoop`，必须提供 `verifyCommand`、`maxIterations`
  和 `expectedStatus`。可选的 `resume` 会先断言持久化 Loop 的初始状态，
  再以额外迭代次数和/或预算调用 `resumeAutoLoop`。
- `session_scenario`：按顺序执行 `agent`、`memory.add`、`memory.approve` 和
  `memory.reject` 步骤。带 `resume: true` 的 agent 步骤会将下一次运行绑定到
  上一个 `sessionId`；每个步骤都会检查终态。

```json
{
  "runner": "loop",
  "mode": "edit",
  "task": "Fix the implementation until tests pass.",
  "loop": {
    "verifyCommand": "npm test",
    "maxIterations": 3,
    "expectedStatus": "passed"
  }
}
```

场景任务可以用 `memory_stats` 检查断言生命周期状态，用
`memory_fact_activity`（`uses`、`exposures` 或 `retrievals`）断言每条事实的
精确计数。路径、正则、终态枚举、别名、有限预算和迭代上限都会在加载数据集时校验。

### 变体（用于 `--variant` / `--ab`）

`--list-variants` 打印变体注册表。当前变体（见 `src/variants.ts`）：
`control`（基线）、`terse-prompt`、`llm-compaction`、`no-memory`、
**`verify-gate`**（启用自验证 finalize 门禁，`verifyCommand=npm test`）、
**`no-auto-verify`**（verify-gate 但仅提示不强制）、**`no-retrieval`**（禁用
任务相关候选清单）、**`review-gate`**（启用 `finalizeReview`）、
**`model-pro`**（在 `deepseek-v4-pro` 下运行）、**`no-progress-guard`**（启用
过早结束防护）、**`context-tight`**（将上下文窗口收窄到 `32000` token 以强制
更早压缩）以及 **`verify-and-review`**（叠加自验证 `npm test` + 自动运行 +
最终 diff 自审查）。用某个开关与 `control` 做 A/B，例如 `--ab control,verify-gate`。

> 坦白说明：在当前（已内置验证提示的）任务集上，`verify-gate` 的 A/B 运行
> 显示**通过率无提升且成本约 +10%** —— 这正是该开关以 opt-in 而非默认开启
> 方式发布的原因。

### 能力实验

设置好 `DEEPSEEK_API_KEY` 后（没有 key ⇒ 运行跳过并以 0 退出），有两个
零核心改动的能力 A/B，各自**一条命令**即可运行。每个实验都会在 `control`
和对应变体下跑完整任务集，然后打印 `toAbMarkdown` 表格（每次采样的
通过/评分/轮数/成本、配对的 Win/Loss/Tie、置信区间、成本分布、成本增量和
单次成功成本），并写出 `evals/reports/ab-<ts>.json` 和 `.md`。

```sh
# Does a tighter context window (earlier/more compaction) save tokens without hurting completion?
pnpm --filter @seekforge/eval-harness eval -- --ab control,context-tight

# Do self-verify (npm test, auto-run) + a final diff self-review raise completion, and at what cost?
pnpm --filter @seekforge/eval-harness eval -- --ab control,verify-and-review
```

- **`context-tight`** 度量强制更早压缩（窗口 `32000`）对 token/成本的影响。
  胜出情形是**成本更低且完成率持平或更好**；风险是压缩丢掉了 agent 仍然
  需要的上下文。
- **`verify-and-review`** 度量叠加两道质量门禁是否能提高**完成率**，
  并核算这些门禁额外消耗的轮数/token。

**如何解读结果并决策：**
- **Win/Loss/Tie** 统计变体在「通过 + 评分」上表现更好/更差/持平的任务数。
  Wins 多于 Losses ⇒ 该改动有助于完成率；Losses 更多 ⇒ 有害
  （对 `context-tight` 来说，Losses 通常意味着压缩过于激进）。
- **单次成功成本（cost-per-success）**是总成本 ÷ 通过任务数 —— 最终底线。
  只有当 cost-per-success **下降**（或持平且 Wins > Losses）时才保留改动。
  如果完成率持平而 cost-per-success 上升（如单独的 `verify-gate` 那样），
  该开关就保持 opt-in，不设为默认。

### Round-52 能力测量

[`evals/round-52-measurements.md`](../evals/round-52-measurements.md) 记录了
round-52 各开关的真实 A/B 运行结果以及复现它们的 runbook。摘要：
**auto-verify** 为正收益（轮数更少，成本约低 30% → 默认开启）；**retrieval**
在可 grep 的任务上没有增益，但在一个刻意制造 grep 噪声的问答任务上 3/3 次
获胜（→ 默认开启，价值集中在困难导航上）；**review-gate** 增加成本却没有
可测量的收益，即使在一个专门为它构造的 fixture 上也是如此（→ opt-in）。
有区分力的 fixture 是 `cjk-find-checkout`（retrieval）和
`cjk-review-edge`（review）；`cjk-large-paginate`（159 个文件）是唯一大到
能同时触发 retrieval（≥40）**和**仓库概览（≥150）下限的 fixture。

## 基线

`evals/baseline.json` 是一份提交入库的报告（`{ generatedAt, results }`），
来自一次**真实**运行 —— 绝不手工编辑或伪造。在一次经过审阅、有意为之的
行为变更之后，按如下方式刷新它：

```sh
pnpm --filter @seekforge/eval-harness eval        # produces evals/reports/<ts>.json
cp evals/reports/<ts>.json evals/baseline.json    # commit with a note on what changed
```

## 回归门禁

```sh
pnpm --filter @seekforge/eval-harness eval -- --baseline evals/baseline.json --fail-on-regression
```

不带 `--suite` 时，`--fail-on-regression` 保持历史行为：仅当基线中的任务出现
pass→fail 时才以非零码退出。重复采样在任务级别按多数结果比较，因此单次
随机失败本身不会触发回归门禁。选择了套件后，它还会强制执行该套件的绝对
阈值和相对基线阈值：

- 最低成功率与最大成功率跌幅；
- 最大单次成功成本与相对成本涨幅；
- 最大单次成功 token 数与相对 token 涨幅；
- 最大工具失败率与相对涨幅；
- 最大会话错误率。

缺少 token 字段的旧版基线仍然有效；只是对它们跳过相对 token 比较。
基线的结构和所有数值字段都会被严格校验，包括有限性/非负约束。
空基线会被拒绝。不带 `--fail-on-regression` 时，任何失败的采样仍会以
非零码退出，这在本地运行时依旧很方便。

## 导入外部基准测试

你可以把一个 SWE-bench 风格的任务（仓库快照 + 指令 + 通过条件）导入本
harness，让它走与原生任务**相同**的确定性门禁。基准测试的格式不会渗入
任何东西：你把它翻译成我们的任务 + fixture 形态，harness 就像对待任何
其他任务一样对待它。

### 原生格式

任务是位于 `evals/tasks/<id>.json` 的一个 JSON 文件：

```json
{
  "id": "portable id, must match the filename and be registered (see below)",
  "title": "human-readable one-liner",
  "fixture": "name of a dir under evals/fixtures/",
  "mode": "edit",
  "task": "the natural-language prompt handed to the agent",
  "checks": [ /* one or more checks, ALL must pass */ ],
  "provenance": { "kind": "dogfood", "source": "问题或事故引用" }
}
```

`id` 长度为 1-128 个字符，首字符必须是 ASCII 字母或数字，后续只能包含
ASCII 字母、数字、`.`、`_` 和 `-`。这样临时工作区名称、报告行和样本匹配
在各平台上都保持明确且可移植。
合成任务可以省略 `provenance`。来自实际使用或外部项目的 `dogfood` 与
`external` 任务必须填写非空 `source`；数据集门禁会据此保证真实项目回归
可追溯，而不会与凭空设计的样例混在一起。

fixture 是位于 `evals/fixtures/<name>/` 的一个**自包含项目**。它必须是
封闭自洽（hermetic）的：没有第三方依赖，其 `package.json` 中没有
`dependencies`/`devDependencies`（数据集门禁会强制检查）。Node、Python、
Go 和 Rust fixture 只使用各自的标准工具链。harness 会把它复制到一个临时目录，
执行 `git init`，然后在那里运行 agent。

检查项（见 `packages/eval-harness/src/task-runner.ts`）是确定性的 ——
没有 LLM 评判。文件检查拒绝符号链接和超过 5 MiB 的文件；命令的 `cwd`
必须解析为临时工作区内的物理目录。检查命令拥有独立进程组、限制捕获输出，
并在超时时终止整个进程组，避免一个任务向后续样本泄漏进程：

- `file_contains` —— `{ type, path, pattern }`：正则必须匹配该文件。
- `file_not_contains` —— 结构相同：正则必须**不**匹配（用于钉死 agent
  不允许做的事，例如修改测试文件）。
- `command_succeeds` —— `{ type, command, cwd? }`：shell 命令必须以 0 退出。
- `answer_matches` —— `{ type, pattern }`：正则必须匹配 agent 的最终摘要。
- `memory_stats` —— `{ type, field, equals, tolerance? }`：比较最终
  `memoryStats(workspace)` 的某个字段。
- `memory_fact_activity` —— `{ type, fact, activity, equals }`：比较某条事实的
  精确 `uses`、`exposures` 或 `retrievals` 计数。

### 映射关系

| 外部基准测试概念        | 本 harness 中的对应物                                   |
| --------------------------------- | ---------------------------------------------- |
| 任务指令 / 问题描述   | 任务 prompt（即 `task` 字段）               |
| 基准 commit 处的仓库快照  | `evals/fixtures/<name>/` 下的一个 fixture 目录   |
| 通过条件（如测试通过） | 一个运行该测试的 `command_succeeds` 检查   |
| 「不许改测试」约束     | 可选的针对测试文件的 `file_not_contains`  |
| 任务 id                           | JSON 文件名 + 一次注册（见下文） |

基准测试自带的标准补丁（gold patch）会被**丢弃** —— agent 应当自己产出修复；
`command_succeeds` 检查（运行基准测试的 fail-to-pass 测试）才是判定
通过与否的依据。

### 完整示例

假设某外部基准测试给了你一个小型 Node 项目，其中 `sum()` 有 bug，
测试 `test/sum.test.js` 当前失败，通过条件是「`npm test` 以 0 退出且不修改测试」。

1. **快照 → fixture。** 把仓库基准 commit 的文件树复制到
   `evals/fixtures/ext-sum-bug/`，剔除一切非封闭自洽的内容。给它一个带
   `test` 脚本且没有依赖的 `package.json`：

   ```json
   { "name": "ext-sum-bug-fixture", "private": true,
     "scripts": { "test": "node --test" } }
   ```

   保留失败的 `test/sum.test.js` 和有 bug 的 `src/sum.js`。

2. **指令 → prompt + 检查。** 创建 `evals/tasks/ext-sum-bug.json`：

   ```json
   {
     "id": "ext-sum-bug",
     "title": "Imported: fix sum() so the suite passes",
     "fixture": "ext-sum-bug",
     "mode": "edit",
     "task": "`npm test` fails in this project. Fix the implementation so all tests pass. Do NOT modify anything under test/. Run the tests to verify.",
     "checks": [
       { "type": "command_succeeds", "command": "npm test" },
       { "type": "file_not_contains", "path": "test/sum.test.js", "pattern": "TODO" }
     ]
   }
   ```

   这个 `command_succeeds` 检查*就是*基准测试的 fail-to-pass 条件；
   `file_not_contains` 约束防止 agent 靠改测试来「通过」。

3. **注册 id。** 把 `"ext-sum-bug"` 加入
   `packages/eval-harness/tests/dataset.test.ts` 的预期 id 数组（保持列表有序），
   并更新其 `it("contains the … expected tasks")` 标题中的数量。数据集门禁随后
   会校验 fixture 存在、封闭自洽，且每个检查的正则都能编译。

之后该任务就和原生任务完全一样地运行
（`pnpm --filter @seekforge/eval-harness eval -- --task ext-sum-bug`）。

## 失败样本归档

当真实使用（dogfooding）中出现真正的失手 —— agent 搞砸了本该能处理的事情 ——
就把它收录到这里，不要让它凭空消失。把该失败最小化成上文格式的
**封闭自洽 fixture**（只使用标准工具链能力、一个把通过条件编码进去的失败
确定性测试，外加一个 `file_not_contains` 约束防止 agent 靠改测试「通过」），
然后在 `packages/eval-harness/tests/dataset.test.ts` 中注册其 id。

有两点保证了可以放心地积极这么做：

- **全新任务绝不会触发 `--fail-on-regression`。** 该门禁只在基线出现
  pass→fail 时触发；不在基线中（或基线中本就是红的）的任务会被忽略。
  因此你可以提交一个记录了我们尚未具备的能力的 fixture，让它保持**红色** ——
  它记录了能力缺口，却不会阻塞任何人。
- 该 fixture 会一直保持红色，直到对应能力真正落地。一旦某次真实运行把它
  变绿并且你刷新了 `evals/baseline.json`，它就成为和其他用例一样的受保护
  用例：此后它上面的回归*会*触发门禁。

要点是让任务集从观察到的现实中生长，而不是仅靠臆想的任务 ——
一个真实失手的最小化复现，比一个合成用例更有价值。在 bug 允许的范围内，
让每个 fixture 尽量小。

## CI

评测工作流既支持 `workflow_dispatch` 也有每周一的定时调度。它从仓库 secrets
读取 `DEEPSEEK_API_KEY`，以三次采样运行 `nightly`，使用已提交的基线、
全部套件门禁、`--require-api-key` 和 JUnit 输出。key 缺失被视为基础设施故障，
而不是一次成功的跳过。它会把当前报告和 `trends.md` 都追加到 GitHub Step
Summary。CI 将完整的报告目录保留为 30 天的 artifact，并发布一个专门的
`eval-trends-<run id>` artifact，其中包含 `trends.json` 和 `trends.md`，
保留 90 天。

新增场景需要在 `evals/` 下添加任务 + fixture，并在
`packages/eval-harness/tests/dataset.test.ts` 中注册；确定性的数据集门禁会
强制检查 fixture 的存在性与封闭自洽性。
