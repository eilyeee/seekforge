/**
 * Direct memory channel: user-stated facts entering project memory without
 * the post-session extraction pipeline (CLI `memory add`, REPL `/remember`).
 *
 * An explicit user statement IS the approval, so the default path writes the
 * bullet to project.md immediately and records an "approved" candidate in
 * candidates.jsonl for audit.
 */

import * as fs from "node:fs";
import { INJECTION_PATTERN } from "./extract.js";
import {
  appendCandidates,
  appendGlobalFact,
  appendProjectFact,
  projectMemoryPath,
  readCandidates,
  readProjectMemory,
  writeCandidates,
  type MemoryCandidate,
  type MemoryCandidateType,
} from "./store.js";

export type AddMemoryFactOptions = {
  content: string;
  /** Defaults to "convention". */
  type?: MemoryCandidateType;
  /** Default true: write to memory now. False queues a pending candidate. */
  approve?: boolean;
  /** Defaults to "manual". */
  sourceSessionId?: string;
  /**
   * "user" writes the approved fact to the user-level file (~/.seekforge,
   * applies to all projects); default "project" writes to this project's
   * project.md. User scope is always approved (no per-project candidate queue).
   */
  scope?: "project" | "user";
};

export type ProjectFact = {
  /** 1-based position among the bullet lines of project.md. */
  index: number;
  line: string;
};

export type ProjectFactSelector = { index: number } | { match: string };

function nextUserFactId(existing: MemoryCandidate[]): string {
  const prefix = `mc-user-${Date.now()}-`;
  const taken = existing.filter((c) => c.id.startsWith(prefix)).length;
  return `${prefix}${taken + 1}`;
}

/**
 * Adds a user-stated fact. Throws on empty content and on content that
 * matches the prompt-injection pattern. Returns the recorded candidate.
 */
export function addMemoryFact(workspace: string, options: AddMemoryFactOptions): MemoryCandidate {
  const content = options.content.trim();
  if (content.length === 0) {
    throw new Error("memory fact content is empty");
  }
  if (INJECTION_PATTERN.test(content)) {
    throw new Error("memory fact rejected: content looks like an instruction to the agent");
  }
  const scope = options.scope ?? "project";
  // User-scope facts are direct, cross-project statements — always approved, and
  // not tracked in the per-project candidate queue.
  const approve = scope === "user" ? true : (options.approve ?? true);
  const candidate: MemoryCandidate = {
    id: nextUserFactId(readCandidates(workspace)),
    content,
    type: options.type ?? "convention",
    confidence: 1, // User-stated, not model-assessed.
    sourceSessionId: options.sourceSessionId ?? "manual",
    createdAt: new Date().toISOString(),
    status: "approved",
  };
  if (scope === "user") {
    appendGlobalFact(candidate); // Dedupes identical lines.
    return candidate;
  }
  if (approve) appendProjectFact(workspace, candidate); // Dedupes identical lines.
  else candidate.status = "pending";
  appendCandidates(workspace, [candidate]);
  return candidate;
}

type ParsedFact = ProjectFact & { lineNo: number };

/** Bullet lines of project.md with their original line numbers. */
function parseProjectFacts(workspace: string): { raw: string; facts: ParsedFact[] } {
  const raw = readProjectMemory(workspace) ?? "";
  const facts: ParsedFact[] = [];
  raw.split("\n").forEach((line, lineNo) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      facts.push({ index: facts.length + 1, line: trimmed, lineNo });
    }
  });
  return { raw, facts };
}

/** Non-empty bullet lines of project.md, 1-based, header excluded. */
export function listProjectFacts(workspace: string): ProjectFact[] {
  return parseProjectFacts(workspace).facts.map(({ index, line }) => ({ index, line }));
}

/**
 * Removes exactly one bullet from project.md — by 1-based index, or by a
 * substring that matches exactly one fact. Everything else (header, blank
 * lines, other bullets) is preserved. Returns the removed line.
 */
export function removeProjectFact(workspace: string, selector: ProjectFactSelector): string {
  const { raw, facts } = parseProjectFacts(workspace);
  let target: ParsedFact;
  if ("index" in selector) {
    const found = facts.find((f) => f.index === selector.index);
    if (!found) throw new Error(`no fact at index ${selector.index} (have ${facts.length})`);
    target = found;
  } else {
    const matches = facts.filter((f) => f.line.includes(selector.match));
    if (matches.length === 0) throw new Error(`no fact matches: ${selector.match}`);
    if (matches.length > 1) {
      const indexes = matches.map((f) => f.index).join(", ");
      throw new Error(`multiple facts match "${selector.match}" (indexes ${indexes}); remove by index`);
    }
    target = matches[0] as ParsedFact;
  }
  const lines = raw.split("\n");
  lines.splice(target.lineNo, 1);
  fs.writeFileSync(projectMemoryPath(workspace), lines.join("\n"), "utf8");
  return target.line;
}

/**
 * Deletes a candidate line entirely (unlike reject, which keeps the entry
 * with status "rejected"). Unknown id throws. Returns the removed candidate.
 */
export function removeCandidate(workspace: string, id: string): MemoryCandidate {
  const candidates = readCandidates(workspace);
  const target = candidates.find((c) => c.id === id);
  if (!target) throw new Error(`candidate not found: ${id}`);
  writeCandidates(
    workspace,
    candidates.filter((c) => c.id !== id),
  );
  return target;
}
