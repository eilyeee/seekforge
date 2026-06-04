/** Canned REST fixtures for mock mode. */
import type { ChatMessage } from "@seekforge/shared";
import type {
  AgentInfo,
  EvolutionProposal,
  McpServer,
  McpTool,
  MemoryCandidate,
  MemoryFact,
  ModelInfo,
  RewindResult,
  ServerConfig,
  SessionMeta,
  Skill,
} from "../types";

export const mockSessions: SessionMeta[] = [
  {
    id: "s-20260610-a1b2",
    task: "Add a --json flag to the run command",
    mode: "edit",
    status: "completed",
    createdAt: "2026-06-10T09:12:00.000Z",
    updatedAt: "2026-06-10T09:15:42.000Z",
    usage: { promptTokens: 18234, completionTokens: 2210, cacheHitTokens: 14200, costUsd: 0.0123 },
  },
  {
    id: "s-20260609-c3d4",
    task: "为 REPL 增加 /help 命令并补充中文文档",
    mode: "edit",
    status: "failed",
    createdAt: "2026-06-09T15:30:00.000Z",
    updatedAt: "2026-06-09T15:31:10.000Z",
    usage: { promptTokens: 4021, completionTokens: 312, cacheHitTokens: 0, costUsd: 0.0021 },
  },
  {
    id: "s-20260608-e5f6",
    task: "Explain how the permission system works",
    mode: "ask",
    status: "cancelled",
    createdAt: "2026-06-08T11:00:00.000Z",
    updatedAt: "2026-06-08T11:02:00.000Z",
  },
];

export const mockSessionMessages: Record<string, ChatMessage[]> = {
  "s-20260610-a1b2": [
    { role: "user", content: "Add a --json flag to the run command" },
    {
      role: "assistant",
      content: "I'll start by publishing a plan, then read the CLI entrypoint.",
      toolCalls: [
        {
          id: "tc-1",
          name: "update_plan",
          argumentsJson: JSON.stringify({
            items: [
              { step: "Read apps/cli/src/index.ts", status: "done" },
              { step: "Add --json flag and JSON renderer", status: "done" },
              { step: "Run typecheck", status: "done" },
            ],
          }),
        },
        { id: "tc-2", name: "read_file", argumentsJson: JSON.stringify({ path: "apps/cli/src/index.ts" }) },
      ],
    },
    {
      role: "tool",
      toolCallId: "tc-1",
      content: JSON.stringify({
        ok: true,
        data: {
          items: [
            { step: "Read apps/cli/src/index.ts", status: "done" },
            { step: "Add --json flag and JSON renderer", status: "done" },
            { step: "Run typecheck", status: "done" },
          ],
        },
      }),
    },
    {
      role: "tool",
      toolCallId: "tc-2",
      content: JSON.stringify({ ok: true, data: { content: "#!/usr/bin/env node\n// ... 120 lines ..." } }),
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tc-3",
          name: "apply_patch",
          argumentsJson: JSON.stringify({ path: "apps/cli/src/index.ts", oldString: "…", newString: "…" }),
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "tc-3",
      content: JSON.stringify({
        ok: true,
        data: {
          diff: [
            "--- a/apps/cli/src/index.ts",
            "+++ b/apps/cli/src/index.ts",
            "@@ -41,6 +41,7 @@",
            '   .option("--mode <mode>", "ask | edit", "edit")',
            '+  .option("--json", "emit events as JSON lines")',
            '   .option("--max-turns <n>", "agent turn limit")',
            "",
          ].join("\n"),
        },
        meta: { path: "apps/cli/src/index.ts" },
      }),
    },
    {
      role: "assistant",
      content: "Done. Added a `--json` flag that switches the renderer to JSON-lines output. Typecheck passes.",
    },
  ],
  "s-20260609-c3d4": [
    { role: "user", content: "为 REPL 增加 /help 命令并补充中文文档" },
    { role: "assistant", content: "好的，我先查看 repl.ts 的命令分发逻辑。" },
  ],
  "s-20260608-e5f6": [
    { role: "user", content: "Explain how the permission system works" },
    {
      role: "assistant",
      content:
        "SeekForge uses permission levels 0-4 (readonly/write/execute/env/dangerous). Tools classify each call; `confirm` mode asks before anything above readonly.",
    },
  ],
};

const skillMd = `# Vitest unit tests

Write fast, deterministic unit tests with vitest.

## When to use

- Adding pure logic (reducers, parsers, formatters)
- Fixing a bug that should never regress

## Steps

1. Co-locate the test as \`<module>.test.ts\`
2. Cover the happy path and one edge case
3. Run \`pnpm test\` and keep the suite green

\`\`\`ts
import { describe, expect, it } from "vitest";

describe("example", () => {
  it("adds", () => {
    expect(1 + 1).toBe(2);
  });
});
\`\`\`
`;

export const mockSkills: Skill[] = [
  {
    id: "vitest-unit-tests",
    scope: "builtin",
    name: "Vitest unit tests",
    description: "Write fast, deterministic unit tests with vitest.",
    tags: ["testing", "typescript"],
    triggers: ["test", "vitest"],
    priority: 10,
    enabled: true,
    risk: "low",
  },
  {
    id: "conventional-commits",
    scope: "global",
    name: "Conventional commits",
    description: "Format commit messages as type(scope): subject.",
    tags: ["git"],
    triggers: ["commit"],
    priority: 5,
    enabled: true,
    risk: "low",
  },
  {
    id: "release-checklist",
    scope: "project",
    name: "Release checklist",
    description: "Steps to cut a SeekForge release (version bump, changelog, npm publish).",
    tags: ["release"],
    triggers: ["release", "publish"],
    priority: 8,
    enabled: false,
    risk: "medium",
  },
];

export const mockSkillContent: Record<string, string> = {
  "vitest-unit-tests": skillMd,
  "conventional-commits": "# Conventional commits\n\n- `feat:` new behaviour\n- `fix:` bug fixes\n- `chore:` plumbing\n",
  "release-checklist": "# Release checklist\n\n1. Bump version\n2. Update CHANGELOG.md\n3. `pnpm publish`\n",
};

export const mockProjectMd = `# Project memory

## Conventions

- TypeScript strict, NodeNext modules — relative imports need \`.js\`
- No new runtime dependencies without strong justification

## Commands

- \`pnpm test\` runs the vitest suite
- \`pnpm typecheck\` runs tsc across the workspace
`;

export const mockFacts: MemoryFact[] = [
  {
    index: 1,
    type: "convention",
    content: "TypeScript strict, NodeNext modules — relative imports need .js",
    addedAt: "2026-05-20T10:00:00.000Z",
    uses: 14,
    lastUsedAt: "2026-06-14T08:00:00.000Z",
  },
  {
    index: 2,
    type: "command",
    content: "`pnpm test` runs the vitest suite",
    addedAt: "2026-06-12T09:00:00.000Z",
    uses: 3,
    lastUsedAt: "2026-06-15T11:00:00.000Z",
  },
  {
    index: 3,
    type: "tech",
    content: "Server is a plain node http server, no framework",
    addedAt: "2026-03-01T09:00:00.000Z",
    uses: 0,
  },
];

export const mockCandidates: MemoryCandidate[] = [
  {
    id: "mc-s1-1",
    content: "Tests live in packages/core/tests, mirrored by source path",
    type: "path",
    confidence: 0.92,
    sourceSessionId: "s-20260610-a1b2",
    createdAt: "2026-06-10T09:15:00.000Z",
    status: "pending",
  },
  {
    id: "mc-s1-2",
    content: "pnpm --filter @seekforge/core test runs only the core suite",
    type: "command",
    confidence: 0.85,
    sourceSessionId: "s-20260610-a1b2",
    createdAt: "2026-06-10T09:15:01.000Z",
    status: "pending",
  },
  {
    id: "mc-s2-1",
    content: "The project uses zod for validation in packages/core only",
    type: "tech",
    confidence: 0.7,
    sourceSessionId: "s-20260609-c3d4",
    createdAt: "2026-06-09T15:31:00.000Z",
    status: "approved",
  },
];

export const mockAgents: AgentInfo[] = [
  {
    id: "explorer",
    scope: "builtin",
    name: "Explorer",
    description: "Read-only codebase scout: finds files, symbols and call sites, reports back with paths.",
    triggers: ["explore", "find", "where"],
    tools: ["read_file", "list_files", "grep"],
    mode: "ask",
    maxTurns: 10,
    body: "# Explorer\n\nA read-only scout. Search broadly, then narrow down.\n\n## Rules\n\n- Never modify files\n- Always report absolute paths\n",
  },
  {
    id: "test-writer",
    scope: "project",
    name: "Test writer",
    description: "Writes vitest unit tests for pure logic; owns packages/core/tests.",
    triggers: ["test", "coverage"],
    mode: "edit",
    own: "packages/core/tests",
    doNotTouch: "production source files",
    boundary: "Only adds or edits test files.",
    maxTurns: 15,
    model: "deepseek-chat",
    body: "# Test writer\n\nWrite fast, deterministic vitest tests.\n\n1. Co-locate as `<module>.test.ts`\n2. Cover the happy path and one edge case\n3. Keep `pnpm test` green\n",
  },
  {
    id: "reviewer",
    scope: "global",
    name: "Reviewer",
    description: "Reviews diffs for correctness bugs and style drift; read-only governance agent.",
    triggers: ["review"],
    tools: ["read_file", "grep", "run_command"],
    mode: "ask",
    body: "# Reviewer\n\nFlag correctness bugs first, style second. Cite file and line.\n",
  },
];

export const mockEvolutionProposals: EvolutionProposal[] = [
  {
    id: "ep-s-20260610-a1b2-1",
    sessionId: "s-20260610-a1b2",
    type: "project_memory",
    title: "Record where the CLI flags are defined",
    problem: "The agent grepped 4 times before finding the commander setup in apps/cli/src/index.ts.",
    evidence: { files: ["apps/cli/src/index.ts"], commands: ["grep -r option apps"] },
    proposal: { content: "- CLI flags are defined with commander in `apps/cli/src/index.ts` (single entrypoint)" },
    risk: "low",
    status: "pending",
    createdAt: "2026-06-10T09:16:00.000Z",
  },
  {
    id: "ep-s-20260609-c3d4-1",
    sessionId: "s-20260609-c3d4",
    type: "skill",
    title: "Skill: REPL command checklist",
    problem: "Adding a REPL command failed twice because the help table and dispatcher live in different files.",
    evidence: { files: ["apps/cli/src/repl.ts"], errors: ["unknown command: /help"] },
    proposal: {
      content: "# REPL command checklist\n\n1. Add the handler in repl.ts dispatch\n2. Register it in the help table\n3. Add a smoke test",
      skillId: "repl-command-checklist",
    },
    risk: "medium",
    status: "pending",
    createdAt: "2026-06-09T15:32:00.000Z",
  },
  {
    id: "ep-s-20260608-e5f6-1",
    sessionId: "s-20260608-e5f6",
    type: "agent_rule",
    title: "Always run typecheck before reporting done",
    problem: "A session reported success while tsc was failing.",
    evidence: { commands: ["pnpm typecheck"] },
    proposal: { content: "- Run `pnpm typecheck` before declaring any task complete" },
    risk: "low",
    status: "applied",
    createdAt: "2026-06-08T11:05:00.000Z",
    reviewedAt: "2026-06-08T12:00:00.000Z",
  },
];

export const mockMcpServers: McpServer[] = [
  {
    name: "context7",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    trusted: false,
    envKeys: ["CONTEXT7_API_KEY"],
  },
];

export const mockMcpTools: Record<string, McpTool[]> = {
  context7: [
    { name: "resolve-library-id", description: "Resolve a package name to a Context7 library id." },
    { name: "query-docs", description: "Fetch up-to-date documentation for a library id." },
  ],
};

/** Only the first mock session has recorded checkpoints. */
export const mockRewindResults: Record<string, RewindResult> = {
  "s-20260610-a1b2": {
    restored: ["apps/cli/src/index.ts"],
    deleted: ["apps/cli/src/render-json.ts"],
    skipped: [],
  },
};

/** Mock models list mirroring core MODEL_PRICING with metadata. */
export const mockModels: ModelInfo[] = [
  {
    id: "deepseek-v4-flash",
    isDefault: true,
    deprecated: false,
    pricing: { inputCacheMissPer1M: 0.14, inputCacheHitPer1M: 0.0028, outputPer1M: 0.28 },
  },
  {
    id: "deepseek-v4-pro",
    isDefault: false,
    deprecated: false,
    pricing: { inputCacheMissPer1M: 0.435, inputCacheHitPer1M: 0.003625, outputPer1M: 0.87 },
  },
  {
    id: "deepseek-chat",
    isDefault: false,
    deprecated: true,
    pricing: { inputCacheMissPer1M: 0.28, inputCacheHitPer1M: 0.028, outputPer1M: 0.42 },
  },
  {
    id: "deepseek-reasoner",
    isDefault: false,
    deprecated: true,
    pricing: { inputCacheMissPer1M: 0.28, inputCacheHitPer1M: 0.028, outputPer1M: 0.42 },
  },
];

export const mockConfig: ServerConfig = {
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  runtimeBin: "",
  commandAllowlist: ["pnpm test", "pnpm typecheck", "git status"],
  apiKey: "sk-abc****",
  sandbox: "workspace-write",
  compaction: "mechanical",
  thinking: false,
  reasoningEffort: null,
  planModel: "",
  escalateOnFailure: false,
  memoryAutoApproveConfidence: undefined,
};
