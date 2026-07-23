# SeekForge 文档

> [English](README.md) | **简体中文**

一个本地优先（local-first）、由 DeepSeek 驱动的编码智能体：提供 CLI、终端 UI、桌面应用，以及可嵌入的核心引擎。项目简介与快速上手请从[项目 README](../README.zh-CN.md) 开始；本目录存放参考文档。

## 使用 SeekForge
- [Cookbook](cookbook.zh-CN.md) — 面向任务的实用指南（修复测试、重构、审查 diff、verify loop、MCP、技能、记忆、worktree、审计、Ark provider）。
- [从 Aider / Cline / Claude Code / Codex 迁移](migration.zh-CN.md) — 概念对照，以及 SeekForge 的独特之处。
- [CLI 参考](cli-reference.zh-CN.md) — `run` / `ask` / `serve` 及全部 flag
  （`--profile`、`--output-style`、`--permission-mode` 等）。
- [配置](configuration.zh-CN.md) — 配置层级与优先级、profile、权限规则、
  hook（含 JSON 输出协议）、输出风格、MCP 服务器、沙箱，以及 TUI 状态栏。
- [MCP](mcp.zh-CN.md) — Model Context Protocol 服务器（stdio + Streamable HTTP）、
  资源、提示词，以及 `${ENV}` 请求头展开。
- [插件](plugins.zh-CN.md) — 一等 skill/agent/MCP/hook 扩展包、绑定摘要的审批、
  生命周期命令与安全边界。
- [浏览器 / 可视化验证](browser.zh-CN.md) — 可选的、基于 Playwright 的
  `browser_navigate` / `browser_screenshot` / `browser_snapshot` /
  `browser_console` 工具，以及前端验证循环。
- [LSP / 精确符号智能](lsp.zh-CN.md) — 可选的、基于语言服务器的
  `lsp_definition` / `lsp_references` / `lsp_diagnostics` 工具，提供精确的
  定义/引用/诊断信息，区别于词法层面的 `repo_map`/`find_definition`。
- [Loop 工程](loop-engineering.zh-CN.md) — 自主的「运行→验证→继续」循环及其护栏机制。
- [Loop 教程](loop-tutorial.zh-CN.md) — 自主 Loop 运行在 CLI、TUI、桌面端、
  恢复、worktree 与 Core API 中的实用用法。
- [定时任务](scheduling.zh-CN.md) — 注册本地 cron/间隔任务
  （`seekforge schedule`）、强制的单次运行成本预算、headless 安全性，
  以及如何将 tick 接入 cron/launchd/systemd。
- [事件触发自动化](automation.zh-CN.md) — 服务器 webhook 触发器，在外部事件发生时
  发起一次 headless、成本受限的运行：原生 GitHub HMAC 投递，
  或通用的 server-token + trigger-secret 认证。
- [自主 GitHub issue → PR](github.zh-CN.md) — `seekforge resolve <issue>`：获取
  issue，在工作分支上以 headless 方式修复，验证后打开一个 draft PR。
  智能体负责修复；用户的 `resolve` 命令执行 push/PR（护城河得以保留）。
- [远程 / 隔离执行](remote.zh-CN.md) — agent-runner 契约与 Docker 参考 runner
  （`seekforge sandbox-run`）：单工作区挂载、密钥经由环境变量传递、
  网络权衡，以及容器化运行的审计。
- [安全扫描](security-scanning.zh-CN.md) — 仓库级 Agent 扫描、Finding 生命周期、
  威胁模型、自动修复验证，以及 JSON/Markdown/SARIF 证据导出。

## 界面与接口
- [内部嵌入 API（`@seekforge/core`）](sdk.zh-CN.md) — 在 monorepo 集成中使用
  这一私有 workspace 引擎：provider 工厂、
  `createAgentCore`/`runTask`、自主循环，以及扩展点。它目前
  不是公开发布的 SDK。
- [CLI](../apps/cli/README.md) · [终端 UI](../apps/tui/README.md) ·
  桌面外壳：[apps/desktop/src-tauri/README.md](../apps/desktop/src-tauri/README.md)
- [服务器 REST + WS API](../apps/server/SERVER-API.md) — 桌面/网页工作台
  所遵循的契约。
- 自定义斜杠命令（frontmatter、`$ARGUMENTS`/`$1..$9`、`:` 命名空间、
  `` !`shell` ``、`run_user_command`）的文档见
  [TUI README](../apps/tui/README.md#custom-commands)。

## 质量维护
- [架构](architecture.zh-CN.md) — 各包职责、依赖方向、状态所有权、
  内部模块边界，以及变更落点。
- [Evals 与回归门禁](EVALS.zh-CN.md) — 确定性 CI 门禁、运行 evals、
  baseline 约定，以及 `--fail-on-regression`。
- [发布](RELEASING.zh-CN.md) — DMG 检查清单、干净机器验证门禁，
  以及 updater 决策。
- [路线图与成熟度](roadmap.zh-CN.md) — 哪些已达生产就绪、哪些仍属实验性，
  以及接下来的加固优先级。

## 笔记与审计
- [低端模型审计](low-end-model-audit.zh-CN.md)
