import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatResponse, FinalReport, TokenUsage } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { MemoryCandidate } from "../../src/memory/index.js";

export function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-memory-test-"));
}

export function writeProjectMemory(workspace: string, content: string): void {
  const file = path.join(workspace, ".seekforge", "memory", "project.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export function readProjectMd(workspace: string): string {
  return fs.readFileSync(path.join(workspace, ".seekforge", "memory", "project.md"), "utf8");
}

export function writeCandidatesRaw(workspace: string, raw: string): void {
  const file = path.join(workspace, ".seekforge", "memory", "candidates.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw, "utf8");
}

export function readCandidatesRaw(workspace: string): string {
  return fs.readFileSync(path.join(workspace, ".seekforge", "memory", "candidates.jsonl"), "utf8");
}

export function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: "mc-s1-1",
    content: "use pnpm as the package manager",
    type: "command",
    confidence: 0.9,
    sourceSessionId: "s1",
    createdAt: "2026-06-10T00:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  costUsd: 0,
};

export function makeReport(overrides: Partial<FinalReport> = {}): FinalReport {
  return {
    summary: "Implemented the login form",
    changedFiles: ["src/login.ts"],
    commandsRun: ["pnpm test"],
    verification: "pnpm test passed",
    usage: ZERO_USAGE,
    ...overrides,
  };
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
