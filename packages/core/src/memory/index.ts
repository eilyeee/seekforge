/**
 * Memory module: project memory, session summaries, memory candidates, brief.
 *
 * Storage (docs/09-memory-system.md): Markdown + JSONL only in this phase.
 *   .seekforge/memory/project.md          long-term approved facts
 *   .seekforge/memory/candidates.jsonl    pending facts awaiting review
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 *
 * Implemented in the memory work stream; stubs until merged.
 */

import type { ChatMessage, FinalReport } from "@seekforge/shared";
import type { ChatProvider } from "../provider/index.js";

export type MemoryCandidateType = "command" | "path" | "convention" | "tech" | "task_pattern";

export type MemoryCandidate = {
  id: string;
  content: string;
  type: MemoryCandidateType;
  /** 0..1, model-assessed. */
  confidence: number;
  sourceSessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
};

/**
 * Short, task-relevant digest of approved project memory for prompt
 * injection. Returns undefined when there is nothing relevant.
 */
export function buildMemoryBrief(_workspace: string, _task: string): string | undefined {
  return undefined;
}

export function readProjectMemory(_workspace: string): string | undefined {
  return undefined;
}

export function listMemoryCandidates(_workspace: string): MemoryCandidate[] {
  return [];
}

/** Appends the fact to project.md and marks the candidate approved. */
export function approveMemoryCandidate(_workspace: string, _id: string): MemoryCandidate {
  throw new Error("not implemented yet (memory work stream)");
}

export function rejectMemoryCandidate(_workspace: string, _id: string): MemoryCandidate {
  throw new Error("not implemented yet (memory work stream)");
}

export type ExtractMemoryInput = {
  workspace: string;
  sessionId: string;
  task: string;
  report: FinalReport;
  /** Full session messages (already compacted upstream if needed). */
  messages: ChatMessage[];
};

export type ExtractMemoryResult = {
  summaryMarkdown: string;
  candidates: MemoryCandidate[];
};

/**
 * One post-task model call: writes a structured summary.md and appends
 * candidate facts to candidates.jsonl. Never throws on model/parse
 * failures — degrades to a minimal summary with zero candidates.
 */
export async function extractMemoryFromSession(
  _provider: ChatProvider,
  _input: ExtractMemoryInput,
): Promise<ExtractMemoryResult> {
  throw new Error("not implemented yet (memory work stream)");
}
