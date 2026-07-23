# 嵌入 SeekForge（`@seekforge/core`）

> [English](sdk.md) | **简体中文**

`@seekforge/core` 是 CLI、TUI 和桌面应用背后的引擎。它目前是一个**私有的 workspace 包**，不是已发布的、遵循 semver 的 npm SDK：`packages/core/package.json` 标注了 `"private": true`，并且直接导出 TypeScript 源码。下面的示例仅面向仓库内集成与贡献者。在它具备构建产物、公开包契约和兼容性策略之前，外部应用不应依赖此包。

在 monorepo 内部，你可以直接嵌入它：构建一个 provider，组装 agent core，然后把任务以流式方式跑到结束。下文出现的每个名字都是 `packages/core/src/index.ts` 的真实导出（该文件转导出 provider、agent、tools、memory、skills、subagents、runtime、mcp、evolution、hooks 和 worktree 模块）。

规范接线方式见 `apps/cli/src/agent-factory.ts`——本指南与之保持一致。

**成熟度：** 内部可用、功能完整，但不是受支持的公开发行版。目前受支持的面向用户的扩展面是 skills、hooks、MCP 和 subagents。

## 核心入口

| 导出 | 用途 |
| --- | --- |
| `resolveProviderConfig(opts)` | 根据 provider 预设（`deepseek`、`ark`、…）解析出 base URL 与能力集，得到 `ProviderConfig`。 |
| `createDeepSeekProvider(config)` | 构建一个 `ChatProvider`（借助预设，适用于 DeepSeek 及任何 OpenAI 兼容 endpoint）。 |
| `createDefaultDispatcher(extraTools?)` | 构建包含全部内置工具的工具调度器，可附加额外的 `ToolSpec[]`（例如来自 MCP）。 |
| `createAgentCore(deps)` | 用 `AgentCoreDeps` 组装出 `AgentCore`。返回 `{ runTask }`。 |
| `createRetryBus()` | 一个重试总线 + `onRetry` 回调，交给 provider 使用（对外暴露 `provider.retry` 事件）。 |
| `runAutoLoop(deps, opts)` | 自主的 run→verify→continue 循环（返回 `LoopResult`）。 |
| `buildSessionAudit(workspace, id)` / `renderSessionAuditMarkdown(audit)` | 构建并渲染确定性的会话审计。 |
| `listSessions(workspace, opts?)` / `loadSessionMessages` / `rewindSession` | 会话追踪相关的辅助函数。 |
| `loadMcpToolSpecs(servers, roots?)` | 启动已配置的 MCP 服务器并返回其 `ToolSpec[]`（附带 `dispose`）。 |
| `loadAgentDefinitions(workspace)` / `loadSkills(workspace)` | 从 `.seekforge/` 加载 subagents 和 skills。 |

Provider 响应会在映射前受限：流式和非流式 body 都有 32 MiB 原始上限，并对
content、reasoning、工具参数设置更严格的上限，同时验证 usage 整数。流式响应还执行
120 秒 idle 超时和 600 秒总超时；内部嵌入方可通过
`ProviderConfig.streamIdleTimeoutMs` 与 `streamTimeoutMs` 覆盖。

## 最小示例

```ts
import {
  createAgentCore,
  createDeepSeekProvider,
  createDefaultDispatcher,
  createRetryBus,
  resolveProviderConfig,
  type AgentCoreDeps,
} from "@seekforge/core";

const retryBus = createRetryBus();

// 1. Provider — resolveProviderConfig applies the preset (base URL + capabilities).
const provider = createDeepSeekProvider(
  resolveProviderConfig({
    provider: "deepseek",                 // or "ark", "openai", "ollama", …
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: "deepseek-v4-flash",
    onRetry: retryBus.onRetry,
  }),
);

// 2. Deps — provider, dispatcher, and confirm are the three required fields.
const deps: AgentCoreDeps = {
  provider,
  retryBus,
  dispatcher: createDefaultDispatcher(),  // all built-in tools; pass MCP specs here
  // Permission gate. Return a boolean (allow-once / deny) or a ConfirmResult.
  confirm: async (_req) => true,          // auto-approve — do NOT do this unattended
};

// 3. Run — runTask yields an async stream of AgentEvents.
const agent = createAgentCore(deps);

for await (const event of agent.runTask({
  projectPath: process.cwd(),
  task: "add a health-check endpoint and a test for it",
  mode: "edit",                            // "ask" for read-only Q&A
  approvalMode: "acceptEdits",             // "confirm" | "acceptEdits" | "auto" | "plan"
})) {
  if (event.type === "model.message") process.stdout.write(event.content);
  if (event.type === "session.completed") console.log("\ncost:", event.report.usage.costUsd);
  if (event.type === "session.failed") console.error(event.error.message);
}
```

`runTask` 以流的形式产出 `AgentEvent`：`session.created`、`model.message`、`tool.started`/`tool.completed`、`permission.required`、`usage.updated`、`file.changed`、`session.completed`、`session.failed` 等（完整见 `packages/shared/src/index.ts` 中的 `AgentEvent` 联合类型）。

Skills 和项目记忆会在运行期间从工作区的 `.seekforge/` 自动发现。若界面层还会组装插件
MCP/hook/agent，应只加载一份 `PluginContributions` 快照并通过
`deps.pluginContributions` 传入；core 会用同一快照加载技能。

## 自主循环

不做单次 `runTask`，而是驱动到某个验证命令退出码为 0：

```ts
import { resumeAutoLoop, runAutoLoop } from "@seekforge/core";

const result = await runAutoLoop(deps, {
  task: "make the suite pass",
  workspace: process.cwd(),
  verifyCommand: "pnpm test",
  maxIterations: 8,
  approvalMode: "acceptEdits",
  onEvent: (e) => console.log(e.type), // includes live `verify.output` chunks
});
// result also includes a persisted loopId.

const resumed = await resumeAutoLoop(deps, result.loopId!, {
  workspace: process.cwd(),
  additionalIterations: 4,
  additionalCostBudgetUsd: 0.5,
});
```

循环状态以原子方式存储在 `.seekforge/loops/` 下；只有当嵌入方自己拥有等效的持久化编排时，才应设置 `persist: false`。迭代次数硬性上限为 100。持久化的 Loop 持有独占租约；写入失败会通过有界的 `loop.warning` 事件上报，不会掩盖验证结果。

## 扩展点

以下均为 `AgentCoreDeps` 的字段（或从工作区自动发现）：

- **自定义工具 / 调度器**——把额外的 `ToolSpec[]` 传给 `createDefaultDispatcher(extraTools)`，或提供你自己的 `dispatcher`。
- **MCP**——`loadMcpToolSpecs(config.mcpServers, [workspacePath])` 返回 `{ specs, dispose }`；把 `specs` 交给调度器（记得调用 `dispose`）。
- **Subagents**——`deps.subagents = loadAgentDefinitions(workspace)` 使它们可经 `dispatch_agent` 及带依赖感知的 `dispatch_team` 调度；`deps.providerForModel` 为子 agent 的 `model` 覆盖构建 provider。
- **Hooks**——`deps.hooks`（一个 `HookConfig`）在工具调用和生命周期各阶段触发 shell hook（`preToolUse` 可以拦截）。参见 [Configuration → hooks](configuration.zh-CN.md#hooks)。
- **Runtime**——`deps.runtime = createRuntimeClient({ binPath })` 把文件 I/O 与命令执行委托给 Rust 后端。
- **沙箱 / 放行清单 / 权限规则**——`deps.sandbox`、`deps.commandAllowlist`、`deps.permissionRules` 决定命令执行方式与权限门禁行为。
- **记忆提取**——`deps.extractMemory: true` 在任务结束后运行记忆提取；`deps.memoryAutoApproveConfidence` 自动批准高置信度的事实。

字段级的精确契约请阅读 `packages/core/src/agent/loop.ts` 中的 `AgentCoreDeps` 类型。
