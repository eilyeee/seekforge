/**
 * Project-memory routes: the memory overview, direct fact add/remove,
 * extraction stats, deterministic compaction, and candidate approve/reject.
 */

import {
  addMemoryFact,
  approveMemoryCandidate,
  compactProjectMemory,
  listMemoryCandidates,
  listProjectFacts,
  MEMORY_CANDIDATE_TYPES,
  memoryStats,
  readMemoryMaintenanceState,
  readFactMeta,
  readProjectMemory,
  rejectMemoryCandidate,
  removeProjectFact,
  type MemoryCandidateType,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export type ApprovedFact = {
  index: number;
  type: string | null;
  content: string;
  addedAt?: string;
  uses: number;
  lastUsedAt?: string;
};

/**
 * Approved project-memory facts joined with their lifecycle metadata.
 * Each fact bullet is `- [type] content`; fact-meta is keyed by the bullet
 * body (`[type] content`, i.e. the line without the leading `- `).
 */
function buildApprovedFacts(workspace: string): ApprovedFact[] {
  const meta = readFactMeta(workspace);
  return listProjectFacts(workspace).map(({ index, line }) => {
    const body = line.replace(/^-\s*/, "").trim();
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(body);
    const type = match ? match[1]! : null;
    const content = match ? match[2]! : body;
    const m = meta[body];
    return {
      index,
      type,
      content,
      addedAt: m?.addedAt,
      uses: m?.uses ?? 0,
      lastUsedAt: m?.lastUsedAt,
    };
  });
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/memory") {
    return sendJson(res, 200, {
      projectMd: readProjectMemory(workspace) ?? null,
      candidates: listMemoryCandidates(workspace),
      facts: buildApprovedFacts(workspace),
      maintenance: readMemoryMaintenanceState(workspace) ?? null,
    });
  }

  // Add an approved fact directly to project memory (CLI `memory add` parity).
  if (method === "POST" && path === "/api/memory/fact") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { content, type, pending, scope } = (body ?? {}) as {
      content?: unknown;
      type?: unknown;
      pending?: unknown;
      scope?: unknown;
    };
    if (typeof content !== "string" || content.trim() === "") {
      return sendApiError(res, 400, "bad_request", "content must be a non-empty string");
    }
    if (type !== undefined && !MEMORY_CANDIDATE_TYPES.includes(type as MemoryCandidateType)) {
      return sendApiError(res, 400, "bad_request", `type must be one of: ${MEMORY_CANDIDATE_TYPES.join(", ")}`);
    }
    if (pending !== undefined && typeof pending !== "boolean") {
      return sendApiError(res, 400, "bad_request", "pending must be a boolean");
    }
    if (scope !== undefined && scope !== "project" && scope !== "user") {
      return sendApiError(res, 400, "bad_request", 'scope must be "project" or "user"');
    }
    try {
      const created = addMemoryFact(workspace, {
        content,
        ...(type !== undefined ? { type: type as MemoryCandidateType } : {}),
        // `pending: true` queues the fact instead of writing it to project.md.
        approve: pending !== true,
        ...(scope === "user" ? { scope: "user" as const } : {}),
      });
      return sendJson(res, 201, created);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendApiError(res, 400, "bad_request", message);
    }
  }

  // Remove an approved fact from project memory, by index or by match.
  if (method === "DELETE" && path === "/api/memory/fact") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { index, match } = (body ?? {}) as { index?: unknown; match?: unknown };
    const hasIndex = typeof index === "number" && Number.isInteger(index);
    const hasMatch = typeof match === "string" && match.trim() !== "";
    if (hasIndex === hasMatch) {
      return sendApiError(
        res,
        400,
        "bad_request",
        "provide exactly one of: index (integer) or match (non-empty string)",
      );
    }
    try {
      const removed = hasIndex
        ? removeProjectFact(workspace, { index: index as number })
        : removeProjectFact(workspace, { match: match as string });
      return sendJson(res, 200, { removed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // No-such-fact / ambiguous-match are client errors, not 500s.
      return sendApiError(res, 400, "bad_request", message);
    }
  }

  // Read-only extraction-quality stats for the workspace's memory state.
  if (method === "GET" && path === "/api/memory/stats") {
    return sendJson(res, 200, memoryStats(workspace));
  }

  // Deterministic project-memory compaction (dedupe/merge, optional prune).
  if (method === "POST" && path === "/api/memory/compact") {
    const body = await readJsonBody(req, res, { emptyOk: true }); // all params optional
    if (body === undefined) return;
    const { dryRun, pruneUnusedDays } = (body ?? {}) as {
      dryRun?: unknown;
      pruneUnusedDays?: unknown;
    };
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      return sendApiError(res, 400, "bad_request", "dryRun must be a boolean");
    }
    if (
      pruneUnusedDays !== undefined &&
      (typeof pruneUnusedDays !== "number" || !Number.isFinite(pruneUnusedDays) || pruneUnusedDays < 0)
    ) {
      return sendApiError(res, 400, "bad_request", "pruneUnusedDays must be a non-negative number");
    }
    return sendJson(
      res,
      200,
      compactProjectMemory(workspace, {
        ...(dryRun !== undefined ? { dryRun } : {}),
        ...(pruneUnusedDays !== undefined ? { pruneUnusedDays } : {}),
      }),
    );
  }

  if (
    method === "POST" &&
    segs.length === 4 &&
    segs[1] === "memory" &&
    (segs[3] === "approve" || segs[3] === "reject")
  ) {
    const id = segs[2]!;
    const approveScope = url.searchParams.get("scope") === "user" ? "user" : "project";
    try {
      const candidate =
        segs[3] === "approve"
          ? approveMemoryCandidate(workspace, id, approveScope)
          : rejectMemoryCandidate(workspace, id);
      return sendJson(res, 200, candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("candidate not found")) {
        return sendApiError(res, 404, "not_found", message);
      }
      throw err;
    }
  }
}
