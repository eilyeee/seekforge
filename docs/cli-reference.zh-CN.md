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

`seekforge loop <task> --verify <command>` 反复运行 agent 与验证命令，直到完成或某道护栏叫停循环。可选的需求分析可避免验证命令为绿但需求仍未完成的假通过。验证使用共享的 shell 执行器，套用已配置的操作系统级沙箱，并响应协作式取消。

| Flag | 说明 |
| --- | --- |
| `--verify <command>` | 必填的成功标准；退出码 0 视为通过。 |
| `--max-iters <n>` | agent 迭代上限；默认 8，不能超过 100。 |
| `--budget <usd>` | 观测到的累计用量达到该值时停止后续工作。在途的 provider 请求可能使最终账单略微超出。 |
| `--requirements quick\|analyze\|confirm` | `quick` 仅依据验证命令；`analyze` 冻结需求并执行验收审查；`confirm` 在分析后暂停，等待显式批准。 |
| `--worktree [name]` | 在新建并保留的 git worktree 中运行；可选择其分支后缀。 |
| `-y, --yes` | 省去自主编辑提示；循环运行本就使用 `acceptEdits`。 |
| `-m, --model <model>` | 覆盖已配置的模型。 |
| `--profile <name>` | 应用一个具名配置 profile。 |

每次调用都会把编排状态持久化到 `.seekforge/loops/`。用 `seekforge loop-resume <loop-id> [--approve-requirements] [--add-iters N] [--add-budget USD]` 可以带着保存的会话、成本、冻结需求和剩余迭代次数继续。对 `--worktree` 循环，需在启动时展示的保留 worktree 内执行该命令。检查运行期间验证输出实时流出；交互式 TUI 通过 `/loop` 提供同样的工作流。

`seekforge loop-list`、`loop-show`、`loop-delete` 管理持久化记录。`seekforge loop-cleanup <name>` 删除一个保留的 `seekforge/loop-*` worktree；有未提交改动的 worktree 因其改动会被丢弃，需要显式加 `--force`。

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
