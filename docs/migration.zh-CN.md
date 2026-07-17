# 从 Aider / Cline / Claude Code / Codex 迁移

> [English](migration.md) | **简体中文**

本文将其他编码智能体的概念客观地映射到 SeekForge 的对应能力。这并非功能对等的承诺——它只是一张查询表，帮助你在 SeekForge 中找到你在其他工具里已经熟悉的功能。

## 概念对照

| 其他工具的概念 | SeekForge 对应能力 |
| --- | --- |
| 编辑格式（unified diff / search-replace / 整文件重写） | `apply_patch` — 逐字 search/replace 编辑，原子化应用；新建文件或整文件重写用 `write_file`。 |
| 模型设置（`--model`、配置中的 `model:`） | `model` 配置键 + `--model`/`-m` flag；`provider` 选择端点预设；`modelPricing` 提供各模型的价格。 |
| 配置文件（`.aider.conf.yml`、`.clinerules`、`settings.json`、`config.toml`） | `.seekforge/config.json`（项目级）+ `~/.seekforge/config.json`（全局）+ `.seekforge/config.local.json`（已 gitignore）。见[配置](configuration.zh-CN.md)。 |
| API 密钥环境变量 | `DEEPSEEK_API_KEY`（Ark provider 则为 `ARK_API_KEY`）；也可用 `apiKey` 配置键。 |
| 项目指令（`CONVENTIONS.md`、`.clinerules`、`CLAUDE.md`、`AGENTS.md`） | `AGENTS.md`（由 `seekforge init` 创建），外加人工筛选的 `.seekforge/project.md` 记忆。 |
| MCP 服务器 | `mcpServers` 配置 + `seekforge mcp add/list/remove`。见 [MCP](mcp.zh-CN.md)。 |
| 斜杠命令 / 自定义命令 | 内置 TUI 斜杠命令 + 自定义命令（frontmatter、`$ARGUMENTS`、`` !`shell` ``）。见 [TUI README](../apps/tui/README.md#custom-commands)。 |
| 子智能体 / 专家智能体 | `dispatch_agent` 名册 — `seekforge agent list/show/import`，定义存放于 `.seekforge/agents/`。 |
| 技能 / 可复用流程 | `.seekforge/skills/<id>/SKILL.md` — `seekforge skill create/list/import`。 |
| 会话历史 / 转录 | `.seekforge/` 下的会话 trace — `seekforge sessions`、`resume`、`replay`、`audit`。 |
| 权限 / 审批模式（自动批准、plan 模式） | 审批模式 `confirm` / `acceptEdits` / `auto` / `plan`；`-y`、`--permission-mode`、`--plan`、`permissionRules`。 |
| 成本 / token 统计 | DeepSeek 内置支持；其他 provider 用 `modelPricing` + `maxCostUsd` 预算；`seekforge models`、TUI `/usage`。 |
| Headless / 脚本模式 | `seekforge -p "<prompt>"` 配合 `--output-format json|stream-json`。见 [CLI 参考](cli-reference.zh-CN.md)。 |

## SeekForge 的独特之处

- **本地优先（local-first）。** 会话、记忆、技能和配置全部存放在项目内的
  `.seekforge/`（或 `~/.seekforge/`）目录下。任何数据都不会上传；
  桌面/网页服务器只绑定 `127.0.0.1`。
- **DeepSeek 原生、provider 灵活。** 出厂即针对 DeepSeek V4 调优
  （思考模式、上下文缓存、内置价格/余额查询），同时可通过 provider 预设
  （`ark`、`openai`、`ollama` 等）对接任何 OpenAI 兼容端点，
  并用 `modelPricing` 计费。
- **确定性会话审计。** `seekforge audit <session-id>`（及 TUI 的
  `/audit`）生成一份可审阅的报告——提示词、每次工具调用（含压缩后的
  参数预览与结果）、变更的文件、成本——直接从磁盘上的 trace 读取，
  不发起任何模型调用。`seekforge replay` 重放渲染一个会话；
  `seekforge rewind` 撤销一个会话的文件变更。
- **分层权限边界。** 内置权限策略，加上细粒度的 `permissionRules`
  （按工具 + 匹配规则允许/拒绝）、可选的操作系统级 `sandbox`
  （`read-only` / `workspace-write` / `restricted`）、`commandAllowlist`，
  以及可以拦截工具调用的 shell `hooks`。
- **Git worktree 会话。** `/worktree new` 让智能体在 `.seekforge/worktrees/`
  下的隔离 `git worktree` 中、以 `seekforge/<slug>` 分支运行，
  你的工作树保持原样不受影响。
- **人工把关的记忆。** 自动提取的事实会保持 **pending（待定）** 状态，
  直到你批准它们（`seekforge memory approve`、TUI `/memory candidates`），
  除非你主动启用 `memoryAutoApproveConfidence`。
- **自主验证循环。** `seekforge loop <task> --verify <cmd>`（TUI 的
  `/loop`）驱动「运行→验证→继续」循环，直到某个 shell 命令以 0 退出。
  见 [Loop 工程](loop-engineering.zh-CN.md)。

上手实践请见 [Cookbook](cookbook.zh-CN.md)。要嵌入引擎，请见
[SDK 指南](sdk.zh-CN.md)。
