# 低能力模型 Bug 审计流程

> [English](low-end-model-audit.md) | **简体中文**

本文档是一套使用低能力模型对 SeekForge 进行审计的分步测试流程。请将每一节作为独立任务分别执行，不要用一条提示词让模型一次性审计整个仓库。

## 0. 基线采集

首先运行以下命令并保存输出：

```sh
git status --short
git diff --stat
pnpm typecheck
pnpm test
pnpm audit --audit-level moderate
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

对每个失败的命令，记录：

```text
Command:
Exit code:
Failure type: assertion failure / environment failure / command misuse / dependency audit
Key output:
Likely affected area:
```

## 1. 配置链路审计

每次只检查一个配置字段。

待测字段：

- `model`
- `planModel`
- `escalateOnFailure`
- `hooks`
- `mcpServers`
- `permissionRules`
- `sandbox`
- `runtimeBin`
- `thinking`
- `reasoningEffort`

需要检查的文件：

```text
README.md
docs/configuration.md
apps/cli/src/config.ts
apps/cli/src/agent-factory.ts
apps/tui/src/config.ts
apps/tui/src/agent/factory.ts
apps/server/src/config.ts
apps/server/src/agent.ts
packages/core/src/agent/loop.ts
packages/core/tests/**/*
```

测试步骤：

1. 在 README/docs 中找到该字段。
2. 在每个入口的配置类型中找到该字段。
3. 检查 `loadConfig` 是否读取并合并了它。
4. 检查入口的 factory 是否把它传给了 `createAgentCore`。
5. 检查 core 是否实际使用了它。
6. 检查测试是否覆盖了完整链路。
7. 报告链路断裂的所有入口。

提示词：

```text
Only audit config wiring for this field:
<field>

Check this path:
docs -> config type -> loadConfig -> factory -> createAgentCore -> core usage -> tests.

Output:
- Field:
- Entry point:
- Chain status: complete / broken / uncertain
- Broken step:
- Evidence: file path + line number
- Trigger condition:
- User impact:
- Missing test:
```

## 2. 跨入口一致性审计

每次只检查一项能力。

待测能力：

- Hooks
- Plan 模型路由
- 失败升级（escalation）
- 沙箱（Sandbox）
- MCP 服务器
- 权限规则
- 运行时后端
- Thinking/reasoning 控制

需要检查的文件：

```text
apps/cli/src/**
apps/tui/src/**
apps/server/src/**
apps/desktop/src-tauri/src/**
packages/core/src/**
docs/configuration.md
README.md
```

测试步骤：

1. 确认文档声称的行为。
2. 检查 CLI 的支持情况。
3. 检查 TUI 的支持情况。
4. 检查 server 的支持情况。
5. 检查 desktop 是否依赖 server 的行为。
6. 比较各入口的行为与配置名称。
7. 报告不一致之处。

提示词：

```text
Only audit cross-entry consistency for this capability:
<capability>

Output table:
Entry point | Reads config | Passes to core | Runtime behavior | Tests | Evidence | Result

Then list only mismatches:
- Mismatch:
- Evidence:
- User impact:
- Suggested test:
```

## 3. 权限与安全审计

需要检查的文件：

```text
packages/core/src/tools/**
packages/core/src/agent/loop.ts
packages/core/src/agent/rules.ts
packages/core/src/hooks/**
packages/core/tests/tools/**
packages/core/tests/agent/**
docs/configuration.md
```

测试步骤：

1. 列出所有 shell 执行点。
2. 列出所有文件读/写/删除点。
3. 列出所有网络请求点。
4. 列出所有权限确认点。
5. 对每个点，识别由模型控制的输入。
6. 确认权限提示中展示的是原始命令/路径。
7. 确认工具结果被当作数据处理，而不是指令。
8. 确认工作区边界与沙箱行为。
9. 确认测试覆盖了拒绝/允许、路径逃逸和命令分类。

提示词：

```text
Only audit permissions and security.

For each execution/write/network/permission point, output:
- Operation:
- Code location:
- Model-controlled inputs:
- Permission level:
- Existing guard:
- Bypass risk:
- Existing tests:
- Missing tests:
- Severity: P0/P1/P2/P3
```

## 4. Agent 循环与 Trace 审计

需要检查的文件：

```text
packages/core/src/agent/loop.ts
packages/core/src/agent/context.ts
packages/core/src/agent/trace.ts
packages/core/tests/agent/**
packages/core/tests/hooks/**
packages/core/tests/subagents/**
```

测试步骤：

1. 追踪一次运行中 `messages` 的变化过程。
2. 追踪每一处 `trace.message` 和 `trace.event` 的调用。
3. 检查工具调用解析以及无效 JSON 的处理行为。
4. 检查失败工具调用的处理。
5. 检查重复失败的检测。
6. 检查 plan 运行和失败升级时的 provider 切换。
7. 检查压缩（compaction）行为。
8. 检查 resume/replay 的前提假设。
9. 检查最大轮数和最大工具调用数的终止逻辑。
10. 将实际行为与测试进行对照。

提示词：

```text
Only audit agent loop and trace behavior.

Output findings using:
- Behavior:
- Code path:
- Trace coverage: traced / not traced / uncertain
- Replay/resume risk:
- Trigger condition:
- Existing test:
- Missing test:
- Severity:
```

## 5. 桌面端发布审计

需要检查的文件：

```text
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/src/serve.rs
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/README.md
apps/desktop/docs/RELEASING.md
.github/workflows/release-desktop.yml
apps/desktop/package.json
```

测试步骤：

1. 从 Tauri 的 `main` 开始追踪启动流程。
2. 检查 server 命令的解析方式。
3. 检查仅安装 DMG（没有全局 CLI、没有源码检出）时应用能否启动。
4. 检查工作区选择逻辑。
5. 检查退出时的进程清理。
6. 检查更新器配置、公钥、产物生成与发布文档。
7. 检查签名/公证（notarization）相关假设。
8. 检查命令解析和 URL 解析的测试。

提示词：

```text
Only audit the Tauri desktop release path.

Assume a user installed only the DMG and has no source checkout and no global seekforge CLI.

Output:
- Can the app start? yes / no / uncertain
- Startup chain:
- External dependencies:
- Failure point:
- User-facing error:
- Evidence:
- Missing release test:
```

## 6. 前端 UI 状态审计

需要检查的文件：

```text
apps/desktop/src/components/**
apps/desktop/src/views/**
apps/desktop/src/lib/i18n/**
apps/desktop/src/index.css
apps/desktop/src/types.ts
```

测试步骤：

1. 检查每个视图的加载、空数据、错误和长数据状态。
2. 检查按钮/卡片是否可能出现文本溢出。
3. 检查固定宽度和固定列布局。
4. 检查长路径、长会话名以及中文文本下的表现。
5. 检查侧边栏和 todos 面板同时打开时的布局。
6. 检查明/暗主题相关假设。
7. 检查 API 失败是否可见、是否可恢复。

提示词：

```text
Only audit frontend UI state and layout risks.

Output:
- Component/view:
- Missing state or layout risk:
- Triggering data/viewport:
- Evidence:
- Suggested manual or Playwright check:
- Severity:
```

## 7. 依赖与发布包审计

需要检查的文件与命令输出：

```text
package.json
pnpm-lock.yaml
apps/*/package.json
packages/*/package.json
pnpm audit --audit-level moderate output
```

测试步骤：

1. 列出高危和中危的 audit 发现。
2. 将每条发现映射到具体包路径。
3. 判断其影响范围：运行时、构建、开发服务器，还是仅发布环节。
4. 检查各包的 `files`、`bin`、`exports` 与构建脚本。
5. 检查 npm 包产物是否包含必需文件。
6. 检查发布/构建命令是否在高风险场景中使用了存在漏洞的工具链。

提示词：

```text
Only audit dependencies and package release risk.

Output:
- Package/advisory:
- Severity:
- Affected dependency path:
- Runtime/build/dev impact:
- Current version:
- Patched version:
- Evidence:
- Suggested verification after upgrade:
```

## 8. 文档一致性审计

需要检查的文件：

```text
README.md
docs/*.md
apps/*/README.md
apps/desktop/docs/RELEASING.md
apps/cli/src/index.ts
apps/cli/src/commands/**
apps/server/src/config.ts
apps/tui/src/config.ts
```

测试步骤：

1. 从文档中提取具体断言。
2. 对每条命令断言，找到对应的命令实现。
3. 对每条配置断言，找到配置类型、加载器、设置入口和运行时使用点。
4. 对每条发布断言，找到匹配的配置/工作流。
5. 对每条默认值断言，与源码常量进行比对。
6. 报告夸大的描述和过期的示例。

提示词：

```text
Only audit documentation consistency.

Output:
- Documentation claim:
- Documentation location:
- Implementation evidence:
- Status: consistent / inconsistent / uncertain
- User impact:
- Suggested doc or code fix:
```

## 9. 最终报告模板

将各节结果合并为以下格式：

```text
## Findings

1. [P0/P1/P2/P3] Title
   - Area:
   - Evidence:
   - Trigger condition:
   - Impact:
   - Recommended fix:
   - Suggested test:

## Verification

- Commands run:
- Passing checks:
- Failing checks:
- Failures caused by environment:
- Not covered:

## Open Questions

- Needs human confirmation:
```

严重程度等级：

- P0：权限绕过、数据丢失、核心功能不可用、发布包不可用。
- P1：主要入口损坏、高危安全发现、文档记载的配置不生效。
- P2：文档与实现不一致、边界情况 bug、缺失回归测试。
- P3：UX 问题、可维护性风险、低概率兼容性问题。
