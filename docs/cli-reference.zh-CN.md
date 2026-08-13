# CLI 参考

> [English](cli-reference.md) | **简体中文**

`seekforge run`、`seekforge ask` 以及 `-p` 无头模式的 flag 参考。

## 图例

- **run** — 适用于 `seekforge run "<task>"`
- **ask** — 适用于 `seekforge ask "<question>"`
- **-p** — 适用于 `seekforge -p "[prompt]"`（无头单次运行）
- **chat** — 适用于 `seekforge`（交互式 REPL 会话）
- ✦ — 也可在 config / 项目设置中配置

## 通用 flag

`-V, --version` 打印已安装的版本号并退出；随后可用 `seekforge update` 去 npm 检查是否有新版本。

| Flag | 适用范围 | 说明 |
| --- | --- | --- |
| `-y, --yes` | run, ask, -p, chat | 自动批准 write/execute 权限（env 级别仍会询问） |
| `-m, --model <model>` ✦ | run, ask, -p, chat | 覆盖模型（`deepseek-v4-flash` / `deepseek-v4-pro`） |
| `--json` | run, ask, -p | `--output-format stream-json` 的别名（机器模式；提示一律拒绝，需搭配 `-y`） |
| `--output-format <fmt>` | run, ask, -p | `text`（默认，面向人类）、`json`（Claude 风格的 result 对象）、`stream-json`（JSONL 信封）、`stream-json-raw`（原始事件） |
| `-c, --continue` | run, ask, -p | 恢复最近一次会话 |
| `--resume <id>` | run, ask, -p | 恢复指定会话（见 `seekforge sessions`） |
| `--add-dir <path>` | run, ask, -p | 为 `@` 引用增加只读根目录（可重复） |
| `--max-turns <n>` | run, ask, -p | 限制 agent 轮次上限 |
| `--max-cost <usd>` | run, -p | 累计成本达到该预算（USD）即停止运行；平缓取消，追踪记录保留。也可通过配置键 `maxCostUsd` 设置（对所有模式生效） |
| `--max-duration <seconds>` | run, -p, sandbox-run, remote-run | 墙钟时间达到该预算即停止运行 —— 它是一个定时器，所以即使运行已经完全不再产生事件（命令卡死、MCP 服务器沉默）也照样触发。作用于整次调用，而不是单个回合。平缓取消，追踪记录保留。也可通过配置键 `maxDurationSeconds` 设置 |
| `--settings <file>` | run, ask, -p, chat | JSON 设置文件路径（叠加在项目配置之上、env/CLI flag 之下） |
| `--profile <name>` ✦ | run, ask, -p, chat | 应用配置文件中名为 `profiles` 的覆盖层；也可用 `SEEKFORGE_PROFILE` 环境变量（flag 优先）。该覆盖层位于 `--settings` 之下一层。作为全局 flag 提供，也可用于 `run` / `ask` / `loop` |

## run 专属 flag

| Flag | 说明 |
| --- | --- |
| `--plan` | 先做只读规划，确认后在同一会话中执行 |
| `--permission-mode <mode>` | `default` / `confirm` — write/execute 时提示；`acceptEdits` — 自动允许工作区内编辑，命令仍提示；`plan` — 确认 + 先规划；`bypassPermissions` / `auto` — 全自动（等同 `-y`）。设置后覆盖 `-y` |
| `--fallback-model <model>` | 主模型过载时用于重试的模型 |
| `--output-style <style>` | `default`（不变）、`concise`（极简）、`explanatory`（边答边讲解）、`learning`（留 1–3 处给用户完成），或自定义的 `.seekforge/output-styles/<name>.md`（见 Configuration） |
| `--system-prompt <text>` | 完全替换系统提示词 |
| `--append-system-prompt <text>` | 向系统提示词追加文本 |
| `--allowedTools <list>` | 仅允许这些工具（逗号分隔） |
| `--disallowedTools <list>` | 拒绝这些工具（逗号分隔） |
| `--dangerously-skip-permissions` | `-y` 的别名——自动批准 write/execute（危险命令仍被拒绝；env 变更仍会询问） |
| `--mcp-config <file>` | 从 JSON 文件加载 MCP 服务器（与配置合并，除非加 `--strict-mcp-config`） |
| `--strict-mcp-config` | 只使用 `--mcp-config` 指定的服务器，忽略配置文件中的 MCP 服务器 |
| `--verbose` | 打印完整的工具参数与结果 |

## ask 专属 flag

| Flag | 说明 |
| --- | --- |
| `--verbose` | 打印完整的工具参数与结果 |

## 无头（`-p`）flag

除上述通用 flag 外：

| Flag | 说明 |
| --- | --- |
| `--ask` | 只读问答模式（不写文件、不执行命令） |
| `-p, --print [prompt]` | 无头单次运行：把结果流式输出到 stdout 后退出（读取管道输入的 stdin） |
| `--output-format <fmt>` | 见通用 flag——另外接受 `stream-json-raw` |
| `--permission-mode <mode>` | 见 run 专属 |
| `--fallback-model <model>` | 见 run 专属 |
| `--output-style <style>` | 见 run 专属 |
| `--system-prompt <text>` | 见 run 专属 |
| `--append-system-prompt <text>` | 见 run 专属 |
| `--allowedTools <list>` | 见 run 专属 |
| `--disallowedTools <list>` | 见 run 专属 |
| `--dangerously-skip-permissions` | 见 run 专属——`-y` 的别名 |
| `--include-partial-messages` | 与 `-p` + `--output-format stream-json` 搭配：输出 assistant 文本的增量片段 |
| `--input-format <fmt>` | `text`（默认）或 `stream-json`（stdin 上按行分隔的用户轮次） |
| `--mcp-config <file>` | 见 run 专属 |
| `--replay-user-messages` | 与 `-p` + `--input-format stream-json` 搭配：把每个用户轮次作为 stream-json 事件回显 |

管道文本输入上限为 16 MiB。使用 `stream-json` 时，每条 JSONL 记录上限为
1,000,000 个字符；仍在等待换行的未终止记录也受此限制，超限输入会在无界占用内存前失败。
| `--strict-mcp-config` | 见 run 专属 |
| `--verbose` | 见 run 专属 |

## 按 hunk 部分应用

当 `apply_patch` 携带**多于一处编辑**被调用时，该工具会把每处编辑归为一个独立的 hunk，附带简短预览。权限提示随即提供按 hunk 选择的能力：CLI 终端里是 `Pick hunks (e.g. 0,2)`，TUI 里是逐 hunk 复选框，桌面端则是弹窗。

当用户只选择部分 hunk 时，agent 收到的是过滤后的编辑集合，仅应用被选中的部分。单处编辑的 `apply_patch` 调用为向后兼容仍保持“全有或全无”。

## 设置分层

`--settings <file>` 加载的 JSON 文件位于本地 / 项目配置层与 env/CLI flag 之间：

| 层级 | 优先级 |
| --- | --- |
| `DEEPSEEK_API_KEY` 环境变量 | 最高 |
| CLI flag（`--model`、`-y`、…） | ↑ |
| `--settings <file>`（JSON） | ↑ |
| 所选 `--profile` 覆盖层（如有） | ↑ |
| `.seekforge/config.local.json`（个人配置，已 gitignore） | ↑ |
| `.seekforge/config.json`（项目） | ↑ |
| `~/.seekforge/config.json`（全局） | 最低 |

对于深合并字段（`mcpServers`、`permissionRules`、`hooks`），settings 层会合并进既有配置，而不是整体替换。
项目层和 local 层会在合并前降权：只有安全偏好、项目 `deny` 规则和未信任 MCP
定义会保留。Hook 与用户级授权只能来自全局配置或用户显式选择的 settings 文件。

## 会话命令

除上面的 run/ask flag 之外，以下子命令操作存储的会话（位于 `.seekforge/sessions/`）：

| 命令 | 作用 |
| --- | --- |
| `seekforge sessions` | 列出最近会话（id、状态、任务） |
| `seekforge resume <id>` | 继续某个会话（最近一次也可用 `run/ask -c`） |
| `seekforge replay <session>` | 把存储会话的事件确定性地重新渲染到 stdout——不调用模型、零成本。`--verbose` 显示完整工具参数 / 结果 |

## Server flag

`seekforge serve [paths...]` 托管本地 Web/API 服务。它接受可重复的
`--workspace <path>`、`--port <n>`，以及以下后台 Loop 控制项：

| Flag | 说明 |
| --- | --- |
| `--loop-auto-resume` | 显式开启：工作区空闲时恢复失去 owner 的 `running` 或已有的 `interrupted` Loop；显式暂停的 Loop 保持暂停。首次检查在 30 秒后执行，之后每 5 分钟检查一次。繁忙工作区及仍有存活 Loop owner 的记录会被跳过；取得的空闲 guard 会覆盖完整恢复，并只放行其自身 Agent 会话。多个工作区顺序处理；瞬时恢复失败会在之后的检查中重试，服务关闭会把其拥有的恢复任务保留为 `interrupted`，供下次启动继续。 |
| `--loop-auto-prune` | 显式开启空闲期终态 Loop 清理。默认清理超过 30 天或排在最新 100 条之外的合格记录；可恢复状态和未完成交付永不参与清理。 |
| `--graph-auto-resume` | 显式开启：物理工作区空闲时恢复失去 owner 的运行中 Graph，或定时器/信号已就绪的 wait 暂停 Graph。人工控制与审批暂停保持暂停；候选使用可变优先级和持久指数退避。 |
| `--graph-auto-prune` | 显式开启空闲期终态 Graph 保留清理。合格托管资源会先归档和清理；脏 worktree 与可恢复 Graph 会保留。 |
| `--orchestration-auto-maintain` | 在各工作区空闲时刷新提案、观测、预测校准、灰度与物化索引；不会自动批准或启动部署。 |
| `--orchestration-auto-rollback` | 与 `--orchestration-auto-maintain` 配合，显式开启终态 canary 回归回滚。 |

自动 Loop 恢复默认关闭，因为恢复后可能调用模型并编辑工作区。恢复沿用 Loop
持久化的额度和 `acceptEdits`；没有用户连接时，超出该模式的权限请求会被拒绝。

## 插件命令

`seekforge plugin`（别名 `plugins`）管理一等扩展包。项目插件只能被发现；安装会把
审核过的目录复制到用户级存储，并保持禁用，直到其精确内容摘要被批准。

| 命令 | 作用 |
| --- | --- |
| `plugin list [--json]` | 列出已安装和项目中发现的插件及审批状态。 |
| `plugin inspect <id> [--json]` | 显示清单或完整插件记录。 |
| `plugin validate <path>` | 不安装，仅校验本地插件。 |
| `plugin create <id>` | 创建 `.seekforge/plugins/<id>/plugin.json` 脚手架。 |
| `plugin install <path>` | 原子安装本地插件，默认禁用。 |
| `plugin update <path>` | 替换已安装插件，并要求重新批准。 |
| `plugin rollback <id>` | 原子恢复上一个已安装版本；恢复后保持禁用，直到其摘要被重新批准。 |
| `plugin supply-chain [--json]` | 报告每个插件的完整性、锁定与当前摘要、API 兼容性、能力与可回滚性。 |
| `plugin enable\|disable <id>` | 批准当前摘要，或移除其全部贡献。 |
| `plugin remove <id>` | 卸载并删除审批状态。 |

清单与安全模型见[插件](plugins.zh-CN.md)。

## GitHub issue 与 review 工作流

这些命令需要已认证的 `gh`、一个 `origin` 远程仓库，以及显式的正数成本预算。agent 负责编辑与验证；由用户主动调用的命令执行 commit、push、创建 PR 以及查看 CI。

| 命令 / flag | 说明 |
| --- | --- |
| `seekforge resolve <issue> --max-cost <usd>` | 拉取 issue，在隔离 worktree 中修复、验证、commit、push，并打开一个 draft PR。`<issue>` 可以是编号或 GitHub issue URL。 |
| `seekforge resolve-review <pr> --max-cost <usd>` | 在隔离 worktree 中检出 PR，处理可执行的评论 / 审查意见，验证、commit 并 push 修复。 |
| `--base <branch>` | 仅 `resolve`：PR 的 base 分支；默认为 `main`。 |
| `-m, --model <model>` | 覆盖这次有界无头运行所用的模型。 |
| `--no-draft` | 仅 `resolve`：创建 ready-for-review 的 PR 而非 draft。 |
| `--no-worktree` | 刻意使用并改动当前检出，而非默认的临时 worktree。 |
| `--wait-ci` | push 后等待 `gh pr checks --watch --fail-fast`。 |
| `--dry-run` | 运行 agent 和验证，然后只打印 commit/push/PR 命令而不执行对外动作。worktree 会保留以供检查。 |

生命周期、清理与安全细节见 [Autonomous GitHub issue → PR](github.zh-CN.md)。

## 自主验证循环

`seekforge loop <task> (--verify <command> | --auto-verify)` 反复运行 agent 与冻结后的验证流水线，直到完成或某道护栏叫停循环。可选的需求分析可避免验证命令为绿但需求仍未完成的假通过。验证使用共享的 shell 执行器，套用已配置的操作系统级沙箱，并响应协作式取消。

| Flag | 说明 |
| --- | --- |
| `--verify <command>` | 显式成功标准；退出码 0 视为通过。不能与 `--auto-verify` 同时使用。 |
| `--auto-verify` | 发现并冻结根目录及有界、按路径选择的 monorepo 包验证阶段。 |
| `--max-iters <n>` | agent 迭代上限；默认 8，不能超过 100。 |
| `--budget <usd>` | 观测到的累计用量达到该值时停止后续工作。在途的 provider 请求可能使最终账单略微超出。 |
| `--token-budget <n>` | 累计 prompt + completion Token 达到上限时停止。 |
| `--max-duration <seconds>` | 可跨恢复累计的总墙钟时间。 |
| `--max-verifies <n>` | 校验执行次数上限，包含首次预检查。 |
| `--verify-timeout <seconds>` | 单次校验超时。 |
| `--agent-timeout <seconds>` | 单次 Agent 尝试超时。 |
| `--agent-retries <n>` | 网络、超时和限流瞬时错误的重试次数；默认 1。 |
| `--verify-stage <id[@路径,...]=命令>` | 追加有序阶段，并可按变更的相对路径前缀选择。增量通过后一定执行完整流水线才会成功。 |
| `--stable-passes <n>` | 要求完整流水线连续通过 1-5 次。 |
| `--flaky-retries <n>` | 对失败阶段重试 0-5 次，并记录抖动通过。 |
| `--stuck-recoveries <n>` | 在 `no_progress` 前用新策略重新诊断 0-5 次。 |
| `--rollback-regressions` | 回退增加解析失败数的迭代；仅限保留的 Loop worktree。 |
| `--adaptive-budget` | 最近用量预测无法装入硬预算时，在下一迭代开始前停止。 |
| `--priority <n>` | 设置 -10 到 10 的自动恢复优先级。 |
| `--deliver <mode>` | 通过后执行 `checkpoint`、`merge`、写 `patch` 或创建草稿 `pr`；仅限保留 worktree。 |
| `--wait-ci` | 与 `--deliver pr` 配合，最长等待 PR checks 15 分钟后再最终完成交付。 |
| `--ci-repairs <n>` | 根据失败 CI 日志执行 0-3 次有界修复；要求 `--wait-ci`。 |
| `--ci-repair-budget <usd>` | 每次 CI 修复的模型成本上限；默认 1。 |
| `--requirements quick\|analyze\|confirm` | `quick` 仅依据验证命令；`analyze` 冻结需求并执行验收审查；`confirm` 在分析后暂停，等待显式批准。 |
| `--worktree [name]` | 在新建并保留的 git worktree 中运行；可选择其分支后缀。 |
| `-y, --yes` | 省去自主编辑提示；循环运行本就使用 `acceptEdits`。 |
| `-m, --model <model>` | 覆盖已配置的模型。 |
| `--model-route <类别=模型[,模型...]>` | 让某个失败类别沿显式有序编辑模型链路由；其他类别可重复传入。 |
| `--model-escalation-threshold <n>` | 每个路由模型处理的连续同类失败次数；1-8，默认 2。 |
| `--profile <name>` | 应用一个具名配置 profile。 |

每次调用都会把编排状态持久化到 `.seekforge/loops/`。`loop-resume` 可用
`--add-iters`、`--add-budget`、`--add-tokens`、`--add-duration` 和
`--add-verifies` 追加额度，并恢复 worker/reviewer 会话、冻结需求与累计资源用量。
对 `--worktree` 循环，需在启动时展示的保留 worktree 内执行该命令。检查运行期间验证输出实时流出；交互式 TUI 通过 `/loop` 提供同样的工作流，并可用 `/loop-pause`、`/loop-continue` 与 `/loop-steer <引导>` 在安全边界控制运行。

`seekforge loop-list`、`loop-show`、`loop-delete` 管理持久化记录；
`seekforge loop-deliver <loop-id> [--mode checkpoint|merge|patch|pr] [--wait-ci] [--ci-repairs N]` 可从保留 worktree
重试失败的通过后交付，无需重跑 Loop；`loop-show` 会展示持久状态、尝试次数、错误与产物。`loop-history`
回放持久事件，`loop-diagnose` 核对检查点与最新保留事件窗口，`loop-health <id>` 报告预算余量、保守的下一轮需求、可承受轮数、恢复退避与匹配验证器可靠性，`loop-intelligence` 报告有界的跨运行验证可靠性与异常，`loop-recover` 把失去 owner 的记录标为 `interrupted`，`loop-priority <id> <n>`
调整恢复顺序，`loop-prune` 只删除合格终态记录。`loop-dag <file>` 以完成驱动方式执行带共享加权预算、
重试、失败策略、组合条件、可审计审批、独占资源、声明产物和结构化依赖输出的持久 JSON 依赖图，并支持
`--resume` / `--dag-id` 检查点。`--approve <node-id>` 可通过节点审批门，
`--rerun <node-id>` 会让该节点及其下游结果失效。
`--predictive-budget` 使用有界历史需求，`--worktree-limit` 限制保留的托管 worktree。
逐节点 `options` 携带有界的 Loop 配置，并由 `export-graph` 原样保留；不支持的键会被指名拒绝。
`--max-concurrency <n>` 并行运行这么多节点（默认 1）；大于 1 时每个并发节点都需要各自的工作区，因此
`loop-dag` 要求逐节点的 `workspace` 字段互不相同，`export-graph` 要求节点工作区相互隔离。
`loop-dag export-graph` 默认输出到 stdout，除非用 `-o, --out <file>` 指定目标；Graph id 默认取内容的确定性
指纹，除非用 `--graph-id <id>` 覆盖。
给 DAG 文件加上 `options` 会改变该 DAG 的指纹，因此请先跑完在途检查点再添加。
`loop-dag-resources <id> inspect|archive|prune|promote` 管理图资源。

**`loop-dag` 与 `loop-dag-resources` 已弃用。** 它们已进入弃用窗口，运行时会在
stderr 打印提示，因此不影响机器可读的 stdout。它们只接受正确性与安全性修复，将在
下一个大版本被移除；已有的 `.seekforge/loop-dags/` 检查点在整个窗口内保持可恢复，
在途的 DAG 可以照常跑完。迁移方式：`seekforge loop-dag export-graph <file> -o
graph.json` → `seekforge graph validate graph.json` → `seekforge graph run
graph.json`。见 [Loop DAG 的弃用窗口](loop-engineering.zh-CN.md#loop-dag-的弃用窗口)。

`loop-speculate <file> --budget <usd> [--speculation-id <id>]` 以工程图 fan-out 的形式持久运行两到三个隔离策略，它们共享同一个预算；`--speculation-id` 固定持久化的 id，使 `--resume` 接回同一次推测而不是另起一次；
`loop-speculation-list` 与 `loop-speculation-promote` 用于查看并显式合并胜出结果，也适用于由 Loop DAG 引擎
记录的推测。
`loop-evidence <id> --format json|sarif|junit [--compare <id>]` 可导出完整性证据或比较运行；`loop-evidence --verify <file>` 重校验导出报告的完整性摘要，不匹配时以非零码退出。
`graph validate|run|resume|list|show|history|diagnose|health|priority|delete` 管理异构工程图；`graph intelligence [graph-id]` 报告有界自适应调度证据，`graph health <graph-id>` 汇总精确指纹预测、瓶颈、血缘与反事实。`graph migration-plan <file>` 预览根与子级失效，`graph expansion-plan <file>` 校验只追加演化，`graph migrate <file>` 应用可恢复树事务，`graph expand <file>` 应用只追加演化。`graph artifact-materialize <sha256> <size> <target>` 恢复一个已验证 CAS blob，加 `--overwrite` 会原子替换目标处已存在的文件而不是拒绝；`graph artifact-store inspect|prune` 检查或引用安全地回收 blob，回收范围由 `--max-bytes <n>` 与 `--max-age-days <n>` 限定（未被引用的 blob 需同时超出两者才会被回收）。`graph simulate <file> [--worst-case]` 无状态预测，`graph explain` 报告阻塞。`graph pause|continue|steer|cancel-node|reprioritize` 写入持久控制信箱，可作用于任何存活进程持有的 Graph；Graph 级命令在安全调度边界生效，针对节点的命令在该节点开始后被拒绝。`graph signal <graph-id> <name> [--payload <json>]` 向等待中的 Graph 投递已声明的外部信号。`graph evidence <graph-id>` 导出防篡改报告，`graph evidence --verify <file>` 重校验其完整性摘要，不匹配时以非零码退出。`graph compare <graph-id> [--run-number N]` 将当前状态与已归档的终态运行做对比。`graph template list|show|register|compare|deprecate` 管理带版本的 schema-v2 注册表，`compare` 在分类为 breaking 时以非零码退出。`orchestration report [--loop-offset N --graph-offset N --limit N]` 增加持久 SLO、全局消耗率、预测校准、上下文路由、运行时重规划、执行器容量、部署、灰度、证明和 CAS 复用。`orchestration policy show|set`、`orchestration index show|refresh`、`orchestration proposals list|refresh|approve|dismiss|apply|rollback|observe`、`orchestration rollout list|start|advance|pause|resume|reconcile [--reason <text>]`、`orchestration controller show|resume [--reason <text>]` 与 `orchestration maintain [--dry-run]` 管理持久生命周期。SLO 消耗率持续处于 critical 时，`orchestration maintain` 会冻结自适应控制器，从而暂停学习式 Graph 调度与上下文 Loop 路由；`orchestration controller resume` 无需等待消耗率自然回落即可解除冻结，`orchestration controller show` 报告当前模式与原因。`orchestration rollout pause` 用于按停正在劣化的金丝雀，并把原因写入灰度时间线。灰度使用证据相互独立的 5%/25%/100% 阶段；`--expected-updated-at` 拒绝过期决策，所有自动回滚均需显式开启——`--auto-rollback` 就是这个开关，而它在不同位置含义不同：加在 `proposals observe` 上表示「观测到指标劣化的已应用部署自动回滚」，加在 `rollout reconcile` 上表示「劣化的金丝雀自动回滚」，加在 `maintain` 上表示「维护 tick 时回滚终态回归」。加在其他子命令上会被拒绝，而不是被忽略。`orchestration policy set` 写入 SLO 阈值，违规判定就由它们导出：`--max-p95-ms`、`--max-failure-rate` 与 `--min-coverage` 是目标本身，`--evaluation-window <n>` 是每个目标的评估样本数，`--max-breach-rate` 是「容忍多少违规才算策略被破坏」；`orchestration report` 也接受前三个作为一次性覆盖，但不会持久化。`orchestration rollout start` 接受 `--min-samples <n>`，即某一阶段获准晋级前所需的终态金丝雀样本数。定义可组合 Agent、Loop、函数、路由、审批门和嵌套图。详见[图工程](graph-engineering.zh-CN.md)。
TUI 与 Desktop/WebSocket Loop 还支持在安全边界暂停、继续、设置优先级和引导。
`seekforge loop-cleanup <name>` 删除一个保留的 `seekforge/loop-*` worktree；有未提交改动的
worktree 因其改动会被丢弃，需要显式加 `--force`。清理会拒绝仍活跃的 Loop 生命周期操作，并保留
包含基线不可达提交的分支；`loop-prune --worktrees` 会在同一 guard 下重新核验完整的已完成 merge
worktree，并原子删除。交付会针对 checkpoint 后的树重新运行完整持久验证流水线，拒绝 verifier/hook
修改，并通过固定的已检查 revision 发布 merge/PR。重试若发现证据 revision 之后存在精确 Loop 状态
路径以外的已提交或本地工作区变更，会拒绝继续。

## 仓库安全

`seekforge security` 在 `.seekforge/security/events.jsonl` 下维护一个只追加的 Finding 队列。agent 的扫描输出只有通过严格的 schema、仓库相对路径、行号范围以及原文摘录的逐字校验之后才会被接受。

| 命令 | 说明 |
| --- | --- |
| `security scan [--max-findings N] [--json]` | 对整个仓库运行一次只读的 Agent 安全扫描。 |
| `security list [--status S] [--severity S] [--json]` | 列出当前的 Finding。 |
| `security show <id> [--json]` | 展示某个 Finding 的证据与修复建议。 |
| `security status <id> <status> [--reason TEXT]` | 记录一次生命周期状态变更。 |
| `security fix <id> --max-cost USD [-y]` | 运行 Agent 修复、项目检查以及验证性复扫。 |
| `security verify <id>` | 只运行项目检查和复扫，不做编辑。 |
| `security threat-model [--json]` | 生成一份有证据支撑的威胁模型。 |
| `security export --format json\|markdown\|sarif [-o PATH]` | 导出一份经脱敏的证据包。 |

生命周期状态为 `open`、`triaged`、`fixing`、`resolved`、`accepted_risk`、`dismissed` 或 `reopened`。验证状态单独跟踪，为 `unverified`、`verified`、`failed` 或 `stale`。验证规则与合规性局限见 [Security scanning](security-scanning.zh-CN.md)。
