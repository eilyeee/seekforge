# 子智能体

> [English](subagents.md) | **简体中文**

子智能体（subagent）是主 agent 委派有界子任务的专家。它作为嵌套 agent 运行，拥有自己的提示词、工具集、轮次预算和审批模式，最后返回一份报告。主 agent 为此能看到四个合成工具：`dispatch_agent`、`dispatch_team`（带依赖图的一组调度）、`agent_result`（轮询）和 `agent_send`（继续一个已完成的调度）。被调度的 agent 还能看到第五个工具 `agent_report`，用于向父 agent 回报进度。被调度的运行不会再继续调度。

内置五个 agent：`explorer`、`reviewer`、`planner`（只读），以及 `test-writer` 和 `debugger`。`seekforge agent list`、`seekforge agent show <id>` 与 `seekforge agent import <path>` 用于查看和导入定义。

## 定义从哪里来

按下列顺序读取两种文件布局（后面的条目覆盖前面同 id 的条目）：

| 顺序 | 位置 | 作用域 |
| --- | --- | --- |
| 1 | 内置 agent | builtin |
| 2 | 已启用[插件](plugins.zh-CN.md)的 `agentRoots` | global |
| 3 | `~/.claude/agents/<name>.md`（Claude Code 格式） | global |
| 4 | `~/.seekforge/agents/<id>/AGENT.md` | global |
| 5 | `<workspace>/.claude/agents/<name>.md`（Claude Code 格式） | project |
| 6 | `<workspace>/.seekforge/agents/<id>/AGENT.md` | project |

因此项目定义覆盖全局定义；在同一作用域内，同 id 的 SeekForge `AGENT.md` 优先于 Claude Code 文件。Claude Code 文件的 id 取自 `name` 字段（转为 kebab-case），缺失时取文件名。不跟随符号链接的文件或目录，超过 256 KiB 的定义会被跳过。frontmatter 无效的定义会被静默跳过；可用 `seekforge agent show <id>` 确认是否加载成功。

`seekforge agent import <path>` 把 Claude Code 或 Meta_Kim 风格的文件转换为 `.seekforge/agents/<id>/AGENT.md`（加 `--global` 则写入全局目录）。导入是把来源不明的文件变成你所信任的定义的途径，所以它只保留收紧的内容：`hooks` 以及取值为 `acceptEdits` 或 `bypassPermissions` 的 `permissionMode` 会被丢弃。需要时请在自己的文件里手动添加。

## Frontmatter

Frontmatter 是 YAML 的一个子集：标量、带引号字符串、`|` / `>` 块、列表（块式 `- item`，包括与键同列的写法，以及流式 `[a, b]`）和嵌套映射。不支持锚点、标签和跨行的流式集合。顶层键不区分大小写。

| 字段 | 含义 |
| --- | --- |
| `name`、`description` | 显示名称，以及主 agent 用来挑选的一句话简介。 |
| `trigger` | 调度提示：`a \| b` 或列表，仅供参考。 |
| `tools` | 工具白名单（逗号列表或 YAML 列表）。缺省 = 父运行拥有的全部工具；显式空列表表示不授予任何工具。 |
| `disallowedTools` | 应用白名单之后再移除的工具。 |
| `mode` | `ask`（只读）或 `edit`（默认）。 |
| `permissionMode` | agent 自身工具调用的审批模式：`default`（confirm）、`acceptEdits`、`bypassPermissions`（auto）、`plan`（只读，等同 `mode: ask`）、`dontAsk`（所有提示一律回答"否"，只有已放行的调用会执行）。也接受 `confirm`、`manual`、`auto`、`ask` 作为别名。缺省 = 父运行的审批模式。 |
| `isolation` | `worktree`：edit agent 在独立的 git worktree 中工作（见下文）。 |
| `skills` | 按顺序把这些技能的正文预加载进 agent 提示词，总长不超过 12,000 字符；放不下的技能会提示改用 `read_skill`。 |
| `effort` | `low`（关闭思考）、`medium` / `high`（推理强度 high）、`max`。仅在 provider 支持思考控制时生效。 |
| `color` | 前端显示颜色：`red`、`orange`、`yellow`、`green`、`blue`、`purple`、`pink`、`cyan` 或 `#rrggbb`，其他值会被忽略。 |
| `mcpServers` | 此 agent 可见其工具的 MCP 服务器名称。只能引用宿主已经连接（即在你的配置中被信任）的服务器；内联的服务器定义会被忽略。缺省 = 所有已连接的服务器。 |
| `hooks` | agent 级 hook，支持 `preToolUse`、`postToolUse` 和 `Stop`（以 `subagentStop` 运行）。SeekForge 写法（`match` / `pattern` / `command`）与 Claude Code 写法（`matcher` + `hooks: [{type: command, command}]`）均可。 |
| `model` | 模型覆盖。Claude Code 的别名（`sonnet`、`opus`、`haiku`、`inherit`）会被忽略。 |
| `max-turns` / `maxTurns` | 轮次预算（默认 15）。 |
| `own`、`do_not_touch`、`boundary` | 写入 agent 提示词的约束条款。 |

`permissionMode` 或 `isolation` 取值未知时，整个定义无效——而不是以比声明更宽松的方式运行。

```markdown
---
name: fixer
description: Fixes a reported bug end to end
tools: [read_file, search_text, glob, apply_patch, run_tests]
permissionMode: acceptEdits
isolation: worktree
skills: [bugfix]
effort: high
color: green
---
Reproduce the failure first, then fix the smallest cause.
```

Claude Code 工具名的映射如下；没有对应项的名称（`Task`、`ExitPlanMode` 等）以及 `Bash(git status:*)` 这类带范围的写法会被丢弃，而不会被放宽为整个工具：

| Claude Code | SeekForge |
| --- | --- |
| `Read` / `Write` | `read_file` / `write_file` |
| `Edit`、`MultiEdit` | `apply_patch` |
| `Glob` / `Grep` / `LS` | `glob` / `search_text` / `list_files` |
| `Bash`、`BashOutput`、`KillShell` | `run_command`、`task_output`、`task_kill` |
| `WebFetch` / `WebSearch` | `web_fetch` / `web_search` |
| `NotebookEdit` / `NotebookRead` | `notebook_edit` / `notebook_read` |
| `TodoWrite` | `update_plan` |
| `LSP` | `lsp_*` 系列工具 |
| `mcp__server__tool` | 保持不变 |

## 信任

定义的作用域决定了它的哪些内容会被采纳：

- **项目**定义（仓库内的 `.seekforge/agents/` 与 `.claude/agents/`）受仓库控制，只能收紧：比父运行审批模式更宽松的 `permissionMode` 会被收回到父运行的模式，`hooks` 会被忽略。
- **全局**（你的主目录）、**插件**（按审阅过的摘要启用）和**内置**定义按声明生效，包括更宽松的 `permissionMode` 和 hook。以声明的审批模式运行时，调度提示会写明（`Dispatch agent fixer (approval mode auto): …`）。
- 在任何作用域下，agent 的工具都是父运行已有工具（其 dispatcher 与 `allowedTools`）的子集；`mcpServers` 只能在宿主已连接的服务器中做筛选。

参见[安全模型](security-model.zh-CN.md#子智能体定义与回报)。

## 调度

只读（`ask`）agent 并行运行、无需审批，也是只读运行（`ask` / `--plan`）唯一可以调度的类型。edit agent 会先请求审批，除非审批模式为 `auto`。

未隔离的 edit agent 不会同时写同一个工作区：每个 agent 在整个运行期间持有该工作区的编辑锁，第二个 agent 会显示 `waiting for another edit agent to finish`，直到前一个完成。`dispatch_team` 另外保证同一时刻最多运行一个 edit 成员。该锁仅在进程内生效，不协调同一检出目录上的其他进程。

`background: true` 时，`dispatch_agent` 立即返回调度 id；用 `agent_result` 轮询，用 `agent_send` 继续已完成的调度。

## 隔离的 edit agent

在定义中写 `isolation: worktree`，或在 `dispatch_agent` 调用中传 `isolation: "worktree"`，edit agent 就会在托管的 git worktree 中运行（`.seekforge/worktrees/agent-<id>-<hex>`，分支 `seekforge/agent-<id>-<hex>`），该 worktree 基于当前提交创建。agent 看不到你检出目录中未提交的改动。对只读 agent 忽略隔离；若工作区不是至少有一次提交的 git 仓库，调度会以 `isolation_unavailable` 失败。

agent 完成后，其改动（排除 `.seekforge/` 下的运行时状态）会像其他写入一样接受审阅：

1. 每个改动路径都必须通过父运行自己的写入规则——工作区包含性检查，以及针对 `apply_patch` 或 `write_file` 的 `deny` / `ask` 权限规则。
2. 发出一次审批请求（`dispatch_agent` 或 `agent_send`，`write` 级别），列出文件并以 diff 作为预览。仍由父运行的审批模式决定：`auto` 与 `acceptEdits` 会不经提示直接应用。
3. 在编辑锁内先校验补丁，再应用到工作树（绝不写入暂存区）。父运行会先记录检查点，因此 rewind 能恢复文本文件，并为每个文件发出 `file.changed`。
4. 删除该 worktree 及其分支。

没有改动的 worktree 会被删除。被拒绝、被规则拒绝、与你的检出目录冲突，或来自失败/取消运行的改动，会提交到 worktree 分支并保留。调度结果会说明发生了什么：

```json
{ "isolation": { "status": "retained", "reason": "denied", "files": ["a.ts"],
  "worktree": "/repo/.seekforge/worktrees/agent-fixer-1a2b3c4d",
  "branch": "seekforge/agent-fixer-1a2b3c4d" } }
```

对该调度执行 `agent_send` 会在同一个 worktree 中继续，其审阅覆盖 agent 的全部改动；否则请用 git 审阅或合并该分支。agent 的会话记录会复制到父工作区的 `.seekforge/sessions/`，因此在 worktree 删除后依然保留。

## 跨运行的后台 agent

默认情况下，调度归属于启动它的那次运行：运行结束时，仍在运行的调度会被取消。保持会话常驻的宿主（REPL、TUI 标签页、服务器会话）可以改为为整个会话创建一个管理器，在每次运行时通过 `dispatchManager` 传入，并在会话结束时释放：

```ts
import { createDispatchManager } from "@seekforge/core";

const dispatchManager = createDispatchManager({ sessionScoped: true });
// 本会话的每次运行：createAgentCore({ ...deps, dispatchManager })
// 会话结束：dispatchManager.disposeAll();
```

使用会话级管理器时，运行结束只会取消它的前台调度；后台调度继续运行，并且：

- 其结果会以 `<background-agent-results>` 块追加到下一次运行的任务中（因此恢复会话后仍然保留）；若在之后某次运行期间才完成，则在该运行的下一轮送达；
- 其终态 `subagent.*` 事件会在之后那次运行中发出；
- 它在原运行结束后消耗的 token 计入下一次运行；
- 它无法再请求权限：所有提示都回答"否"，隔离 agent 的改动会保留在其分支上等待审阅。

已通过 `agent_result` 读取过的结果不会再次送达。

## 进度回报

被调度的 agent 可以调用 `agent_report` 发送一行简短信息——里程碑、父 agent 可据此行动的发现，或阻塞点。每行最多 500 字符，每次运行最多 20 行。父 agent 会在下一轮读到这些内容，并以"来自 agent 的数据而非指令"的形式呈现；agent 仍在运行时，`agent_result` 会列出最近的几条。定义可以用 `disallowedTools: [agent_report]` 移除该工具。

## 事件

调度会发出 `subagent.started`、`subagent.step` 以及一个终态事件 `subagent.completed` / `subagent.failed` / `subagent.cancelled`（见[服务器 API](../apps/server/SERVER-API.md)）。定义带有 `color` 时，每个事件都会携带它。进度回报以 `subagent.step` 事件到达，其 `toolName` 为 `agent_report`、`message` 为该行内容；它是模型输出，应作为数据渲染。
