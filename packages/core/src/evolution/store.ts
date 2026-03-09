/**
 * Evolution proposal storage: JSONL under .seekforge/evolution/.
 *   .seekforge/evolution/proposals.jsonl   one EvolutionProposal JSON per line
 *
 * Append-only for new proposals; status updates rewrite the file
 * (same pattern as memory candidates). Corrupt lines are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  EVOLUTION_PROPOSAL_TYPES,
  type EvolutionProposal,
  type EvolutionProposalStatus,
  type EvolutionProposalType,
} from "./types.js";

export function evolutionProposalsPath(workspace: string): string {
  return path.join(workspace, ".seekforge", "evolution", "proposals.jsonl");
}

export function sessionReflectionPath(workspace: string, sessionId: string): string {
  return path.join(workspace, ".seekforge", "sessions", sessionId, "reflection.md");
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

const STATUSES: readonly EvolutionProposalStatus[] = ["pending", "accepted", "rejected", "applied"];

function isProposalRecord(value: unknown): value is EvolutionProposal {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const proposal = p.proposal as Record<string, unknown> | undefined;
  return (
    typeof p.id === "string" &&
    typeof p.sessionId === "string" &&
    EVOLUTION_PROPOSAL_TYPES.includes(p.type as EvolutionProposalType) &&
    typeof p.title === "string" &&
    typeof p.problem === "string" &&
    typeof p.evidence === "object" &&
    p.evidence !== null &&
    typeof proposal === "object" &&
    proposal !== null &&
    typeof proposal.content === "string" &&
    (p.risk === "low" || p.risk === "medium" || p.risk === "high") &&
    STATUSES.includes(p.status as EvolutionProposalStatus) &&
    typeof p.createdAt === "string"
  );
}

/** Proposals in file (append/chronological) order; corrupt lines are skipped. */
export function readEvolutionProposals(workspace: string): EvolutionProposal[] {
  const raw = readFileIfExists(evolutionProposalsPath(workspace));
  if (!raw) return [];
  const proposals: EvolutionProposal[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isProposalRecord(parsed)) proposals.push(parsed);
    } catch {
      // Corrupt line: tolerate and skip.
    }
  }
  return proposals;
}

export function listEvolutionProposals(workspace: string): EvolutionProposal[] {
  // File order is append (chronological) order; newest first means reversed.
  return readEvolutionProposals(workspace).reverse();
}

export function readEvolutionProposal(workspace: string, id: string): EvolutionProposal {
  const proposal = readEvolutionProposals(workspace).find((p) => p.id === id);
  if (!proposal) {
    throw new Error(`proposal not found: ${id}`);
  }
  return proposal;
}

export function appendEvolutionProposals(
  workspace: string,
  proposals: EvolutionProposal[],
): void {
  if (proposals.length === 0) return;
  const file = evolutionProposalsPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = proposals.map((p) => `${JSON.stringify(p)}\n`).join("");
  fs.appendFileSync(file, lines, "utf8");
}

function writeProposals(workspace: string, proposals: EvolutionProposal[]): void {
  const file = evolutionProposalsPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = proposals.map((p) => `${JSON.stringify(p)}\n`).join("");
  fs.writeFileSync(file, lines, "utf8");
}

/**
 * Status transitions, human-review gated:
 *   pending  → accepted | rejected   (sets reviewedAt)
 *   accepted → applied
 * Anything else throws.
 */
export function setEvolutionProposalStatus(
  workspace: string,
  id: string,
  status: "accepted" | "rejected" | "applied",
): EvolutionProposal {
  const proposals = readEvolutionProposals(workspace);
  const target = proposals.find((p) => p.id === id);
  if (!target) {
    throw new Error(`proposal not found: ${id}`);
  }
  if (status === "applied") {
    if (target.status !== "accepted") {
      throw new Error(`proposal ${id} must be accepted before apply (status: ${target.status})`);
    }
  } else if (target.status !== "pending") {
    throw new Error(`proposal ${id} is not pending (status: ${target.status})`);
  }
  target.status = status;
  if (status !== "applied") {
    target.reviewedAt = new Date().toISOString();
  }
  writeProposals(workspace, proposals);
  return target;
}
