import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatResponse, SessionStatus, TokenUsage } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { EvolutionProposal } from "../../src/evolution/index.js";

export function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-evolution-test-"));
}

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  costUsd: 0,
};

export type ToolCallFixture = {
  toolName: string;
  ok: boolean;
  errorCode?: string | null;
  args?: Record<string, unknown>;
};

export type SessionFixture = {
  sessionId?: string;
  status?: SessionStatus;
  mode?: "ask" | "edit";
  task?: string;
  costUsd?: number;
  /** Number of assistant messages to synthesize (default 2). */
  assistantTurns?: number;
  finalAnswer?: string;
  toolCalls?: ToolCallFixture[];
};

/** Writes session.json + messages.jsonl + tool-calls.jsonl for one session. */
export function writeSessionFixture(workspace: string, fixture: SessionFixture = {}): string {
  const sessionId = fixture.sessionId ?? "sess1";
  const dir = path.join(workspace, ".seekforge", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const meta = {
    id: sessionId,
    task: fixture.task ?? "implement the login form",
    mode: fixture.mode ?? "edit",
    status: fixture.status ?? "completed",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:05:00.000Z",
    usage: { ...ZERO_USAGE, costUsd: fixture.costUsd ?? 0.01 },
  };
  fs.writeFileSync(path.join(dir, "session.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const turns = fixture.assistantTurns ?? 2;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: meta.task },
  ];
  for (let i = 1; i < turns; i++) {
    messages.push({ role: "assistant", content: `working on step ${i}` });
    messages.push({ role: "tool", content: '{"ok":true}' });
  }
  if (turns > 0) {
    messages.push({ role: "assistant", content: fixture.finalAnswer ?? "Done. Verified with pnpm test." });
  }
  fs.writeFileSync(
    path.join(dir, "messages.jsonl"),
    messages.map((m) => `${JSON.stringify({ ts: meta.createdAt, ...m })}\n`).join(""),
  );

  const toolCalls = fixture.toolCalls ?? [];
  fs.writeFileSync(
    path.join(dir, "tool-calls.jsonl"),
    toolCalls
      .map((t) =>
        `${JSON.stringify({
          ts: meta.createdAt,
          toolName: t.toolName,
          args: t.args ?? {},
          ok: t.ok,
          errorCode: t.errorCode ?? null,
          durationMs: 5,
        })}\n`,
      )
      .join(""),
  );
  return sessionId;
}

export function okCall(toolName: string, args: Record<string, unknown> = {}): ToolCallFixture {
  return { toolName, ok: true, args };
}

export function failedCall(
  toolName: string,
  errorCode = "command_failed",
  args: Record<string, unknown> = {},
): ToolCallFixture {
  return { toolName, ok: false, errorCode, args };
}

export function runCommandCall(command: string, ok = true): ToolCallFixture {
  return { toolName: "run_command", ok, args: { command }, errorCode: ok ? null : "command_failed" };
}

export function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    id: "ep-sess1-1",
    sessionId: "sess1",
    type: "agent_rule",
    title: "Run typecheck after edits",
    problem: "The session edited TypeScript files but never ran the typechecker.",
    evidence: { commands: ["pnpm typecheck"] },
    proposal: { content: "Run pnpm typecheck after editing TypeScript files." },
    risk: "low",
    status: "pending",
    createdAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

export function writeProposalsRaw(workspace: string, raw: string): void {
  const file = path.join(workspace, ".seekforge", "evolution", "proposals.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw, "utf8");
}

export function readProposalsRaw(workspace: string): string {
  return fs.readFileSync(path.join(workspace, ".seekforge", "evolution", "proposals.jsonl"), "utf8");
}

export function readReflection(workspace: string, sessionId = "sess1"): string {
  return fs.readFileSync(
    path.join(workspace, ".seekforge", "sessions", sessionId, "reflection.md"),
    "utf8",
  );
}

/**
 * Scripted fake ChatProvider: returns the queued contents in order, or
 * throws when scripted with an Error. Records requests for assertions.
 */
export function makeFakeProvider(script: (string | Error)[]): ChatProvider & {
  requests: ChatRequest[];
} {
  const queue = [...script];
  const requests: ChatRequest[] = [];
  async function chat(req: ChatRequest): Promise<ChatResponse> {
    requests.push(req);
    const next = queue.shift();
    if (next === undefined) throw new Error("fake provider script exhausted");
    if (next instanceof Error) throw next;
    return { content: next, toolCalls: [], usage: ZERO_USAGE, finishReason: "stop" };
  }
  return {
    chat,
    chatStream: async () => {
      throw new Error("chatStream not scripted");
    },
    model: "fake-model",
    requests,
  };
}
