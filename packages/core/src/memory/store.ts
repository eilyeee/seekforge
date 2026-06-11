/**
 * Memory storage: Markdown + JSONL files under .seekforge/ (no database).
 *   .seekforge/memory/project.md          approved long-term facts
 *   .seekforge/memory/candidates.jsonl    one MemoryCandidate JSON per line
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type MemoryCandidateType = "command" | "path" | "convention" | "tech" | "task_pattern";

export const MEMORY_CANDIDATE_TYPES: readonly MemoryCandidateType[] = [
  "command",
  "path",
  "convention",
  "tech",
  "task_pattern",
];

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

export function projectMemoryPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "project.md");
}

export function candidatesPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "memory", "candidates.jsonl");
}

export function sessionSummaryPath(workspace: string, sessionId: string): string {
  return path.join(workspace, ".seekforge", "sessions", sessionId, "summary.md");
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function readProjectMemory(workspace: string): string | undefined {
  return readFileIfExists(projectMemoryPath(workspace));
}

function isCandidateRecord(value: unknown): value is MemoryCandidate {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.content === "string" &&
    MEMORY_CANDIDATE_TYPES.includes(c.type as MemoryCandidateType) &&
    typeof c.confidence === "number" &&
    typeof c.sourceSessionId === "string" &&
    typeof c.createdAt === "string" &&
    (c.status === "pending" || c.status === "approved" || c.status === "rejected")
  );
}

/** Candidates in file (append) order; corrupt lines are skipped. */
export function readCandidates(workspace: string): MemoryCandidate[] {
  const raw = readFileIfExists(candidatesPath(workspace));
  if (!raw) return [];
  const candidates: MemoryCandidate[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isCandidateRecord(parsed)) candidates.push(parsed);
    } catch {
      // Corrupt line: tolerate and skip.
    }
  }
  return candidates;
}

export function listMemoryCandidates(workspace: string): MemoryCandidate[] {
  // File order is append (chronological) order; newest first means reversed.
  return readCandidates(workspace).reverse();
}

export function appendCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  if (candidates.length === 0) return;
  const file = candidatesPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
  fs.appendFileSync(file, lines, "utf8");
}

/** Module-internal (used by direct.ts); not part of the public barrel. */
export function writeCandidates(workspace: string, candidates: MemoryCandidate[]): void {
  const file = candidatesPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = candidates.map((c) => `${JSON.stringify(c)}\n`).join("");
  fs.writeFileSync(file, lines, "utf8");
}

export function formatFactBullet(candidate: Pick<MemoryCandidate, "type" | "content">): string {
  return `- [${candidate.type}] ${candidate.content}`;
}

/** Appends a fact bullet to project.md, creating it with a header if needed. */
export function appendProjectFact(workspace: string, candidate: MemoryCandidate): void {
  const file = projectMemoryPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bullet = formatFactBullet(candidate);
  const existing = readFileIfExists(file);
  if (existing === undefined) {
    fs.writeFileSync(file, `# Project Memory\n${bullet}\n`, "utf8");
    return;
  }
  // Dedupe: skip when an identical content line already exists.
  if (existing.split("\n").some((line) => line.trim() === bullet)) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${sep}${bullet}\n`, "utf8");
}

function setCandidateStatus(
  workspace: string,
  id: string,
  status: MemoryCandidate["status"],
): MemoryCandidate {
  const candidates = readCandidates(workspace);
  const target = candidates.find((c) => c.id === id);
  if (!target) {
    throw new Error(`candidate not found: ${id}`);
  }
  target.status = status;
  writeCandidates(workspace, candidates);
  return target;
}

/** Appends the fact to project.md and marks the candidate approved. */
export function approveMemoryCandidate(workspace: string, id: string): MemoryCandidate {
  const candidate = setCandidateStatus(workspace, id, "approved");
  appendProjectFact(workspace, candidate);
  return candidate;
}

export function rejectMemoryCandidate(workspace: string, id: string): MemoryCandidate {
  return setCandidateStatus(workspace, id, "rejected");
}
