# Embedding SeekForge (`@seekforge/core`)

> **English** | [简体中文](sdk.zh-CN.md)

`@seekforge/core` is the engine behind the CLI, TUI, and desktop app. It is
currently a **private workspace package**, not a published or semver-stable npm
SDK: `packages/core/package.json` has `"private": true` and exports TypeScript
source directly. The examples below are for in-repository integrations and
contributors. External applications should not depend on this package until it
has a build artifact, public package contract, and compatibility policy.

Inside the monorepo, you can embed it directly: build a provider, assemble the
agent core, and stream a task to completion. Every name below is a real export
from `packages/core/src/index.ts` (which re-exports the provider, agent, tools,
memory, skills, subagents, runtime, mcp, evolution, hooks, and worktree
modules).

The canonical wiring lives in `apps/cli/src/agent-factory.ts` — this guide
mirrors it.

**Maturity:** internal and functional, but not a supported public distribution.
Skills, hooks, MCP, and subagents are the supported user-facing extension
surfaces today.

## Core entry points

| Export | Purpose |
| --- | --- |
| `resolveProviderConfig(opts)` | Resolve base URL + capabilities from a provider preset (`deepseek`, `ark`, …) into a `ProviderConfig`. |
| `createDeepSeekProvider(config)` | Build a `ChatProvider` (works for DeepSeek and any OpenAI-compatible endpoint via presets). |
| `createDefaultDispatcher(extraTools?)` | Build the tool dispatcher with all built-in tools, plus any extra `ToolSpec[]` (e.g. from MCP). |
| `createAgentCore(deps)` | Assemble the `AgentCore` from `AgentCoreDeps`. Returns `{ runTask }`. |
| `createRetryBus()` | A retry bus + `onRetry` callback to hand the provider (surfaces `provider.retry` events). |
| `runAutoLoop(deps, opts)` | The autonomous run→verify→continue loop (returns a `LoopResult`). |
| `buildSessionAudit(workspace, id)` / `renderSessionAuditMarkdown(audit)` | Build and render a deterministic session audit. |
| `listSessions(workspace, opts?)` / `loadSessionMessages` / `rewindSession` | Session-trace helpers. |
| `loadMcpToolSpecs(servers, roots?)` | Spawn configured MCP servers and return their `ToolSpec[]` (+ `dispose`). |
| `loadAgentDefinitions(workspace)` / `loadSkills(workspace)` | Load subagents and skills from `.seekforge/`. |

Provider responses are bounded before mapping: both streaming and non-streaming
bodies have a 32 MiB raw limit, with tighter content/reasoning/tool-argument
limits and validated usage integers. Streaming additionally enforces a 120 s
idle timeout and a 600 s total timeout; internal embedders can override these
with `ProviderConfig.streamIdleTimeoutMs` and `streamTimeoutMs`.

## Minimal example

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

`runTask` streams `AgentEvent`s: `session.created`, `model.message`,
`tool.started`/`tool.completed`, `permission.required`, `usage.updated`,
`file.changed`, `session.completed`, `session.failed`, and more (see the
`AgentEvent` union in `packages/shared/src/index.ts`).

Skills and project memory are discovered automatically from the workspace's
`.seekforge/` during the run. Surfaces that assemble plugin MCP/hooks/agents
should load one `PluginContributions` snapshot and pass it as
`deps.pluginContributions`; core then uses the same snapshot for skills.

## The autonomous loop

Instead of a single `runTask`, drive to a verify command's exit 0:

```ts
import { createLoopControl, resumeAutoLoop, runAutoLoop, runLoopDag } from "@seekforge/core";

const control = createLoopControl();

const running = runAutoLoop(deps, {
  task: "make the suite pass",
  workspace: process.cwd(),
  verifyCommand: "pnpm test",
  verificationPlan: [
    { id: "types", command: "pnpm typecheck" },
    { id: "tests", command: "pnpm test" },
  ],
  stablePasses: 2,
  flakyRetries: 1,
  maxNoProgressRecoveries: 1,
  maxIterations: 8,
  costBudgetUsd: 1,
  tokenBudget: 100_000,
  maxDurationMs: 30 * 60_000,
  maxVerifyRuns: 12,
  verifyTimeoutMs: 10 * 60_000,
  agentTimeoutMs: 15 * 60_000,
  maxAgentRetries: 2,
  approvalMode: "acceptEdits",
  control,
  onEvent: (e) => console.log(e.type), // includes live `verify.output` chunks
});

control.pause();                 // observed at the next safe boundary
control.steer("focus on parser tests");
control.resume();
const result = await running;

const graph = await runLoopDag(deps, {
  workspace: process.cwd(),
  nodes: [
    { id: "core", task: "fix core", verifyCommand: "pnpm --filter @seekforge/core test" },
    { id: "apps", task: "fix apps", verifyCommand: "pnpm test", dependsOn: ["core"] },
  ],
});
// result includes a persisted loopId.

const resumed = await resumeAutoLoop(deps, result.loopId!, {
  workspace: process.cwd(),
  additionalIterations: 4,
  additionalCostBudgetUsd: 0.5,
  additionalTokenBudget: 50_000,
  additionalDurationMs: 10 * 60_000,
  additionalVerifyRuns: 4,
});
```

Loop state is stored atomically under `.seekforge/loops/`; set `persist: false`
only for embedders that own equivalent durable orchestration. Iterations are
hard-capped at 100. Persisted Loops hold an exclusive lease; write failures are
reported through bounded `loop.warning` events without masking verification.
`LoopResult.status` distinguishes `passed`, guardrail `budget` exits (with
`budgetReason`), verifier failures, cancellation, no-progress/exhaustion, and
`agent_error` (with structured provider/session error details).
`autoResumeInterruptedLoops` recovers durable `running` records whose lease owner
disappeared. Final success extracts memory once and settles selected-skill
effectiveness once for the whole Loop.

## Extension points

All are fields on `AgentCoreDeps` (or discovered from the workspace):

- **Custom tools / dispatcher** — pass extra `ToolSpec[]` to
  `createDefaultDispatcher(extraTools)`, or supply your own `dispatcher`.
- **MCP** — `loadMcpToolSpecs(config.mcpServers, [workspacePath])` returns
  `{ specs, dispose }`; hand `specs` to the dispatcher (remember to `dispose`).
- **Subagents** — `deps.subagents = loadAgentDefinitions(workspace)` makes them
  dispatchable via `dispatch_agent` and the dependency-aware `dispatch_team`;
  `deps.providerForModel`
  builds a provider for a subagent's `model` override.
- **Hooks** — `deps.hooks` (a `HookConfig`) fires shell hooks around tool calls
  and lifecycle stages (`preToolUse` can block). See
  [Configuration → hooks](configuration.md#hooks).
- **Runtime** — `deps.runtime = createRuntimeClient({ binPath })` delegates file
  I/O and command execution to the Rust backend.
- **Sandbox / allowlist / permission rules** — `deps.sandbox`,
  `deps.commandAllowlist`, `deps.permissionRules` shape command execution and
  the permission gate.
- **Memory extraction** — `deps.extractMemory: true` runs post-task memory
  extraction; `deps.memoryAutoApproveConfidence` auto-approves high-confidence
  facts.

For the exact field-by-field contract, read the `AgentCoreDeps` type in
`packages/core/src/agent/loop.ts`.
