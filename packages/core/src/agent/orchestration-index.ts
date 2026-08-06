import { createHash } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { listWorkspaceEngineeringGraphTreeStates } from "./graph-migration.js";
import { listLoopStates } from "./loop-state.js";
import { isDenseArray } from "./orchestration.js";
import { loopOrchestrationFingerprint } from "./orchestration-intelligence.js";
import { acquireSessionLease } from "./session-lease.js";
import { compareByCodePoints } from "@seekforge/shared";

export type WorkspaceOrchestrationIndexItem = {
  kind: "loop" | "graph";
  id: string;
  fingerprint: string;
  status: string;
  updatedAt: string;
  costUsd: number;
  tokensUsed: number;
  activeDurationMs: number;
  failures: number;
  parent?: { graphId: string; nodeId: string };
};

export type WorkspaceOrchestrationIndex = {
  version: 1;
  generation: string;
  generatedAt: string;
  totals: {
    loops: number;
    graphs: number;
    costUsd: number;
    tokensUsed: number;
    activeDurationMs: number;
    failures: number;
  };
  items: WorkspaceOrchestrationIndexItem[];
};

const PATH = ".seekforge/orchestration-index.json";
const MAX_BYTES = 512 * 1024;
const MAX_ITEMS = 512;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function validItem(value: unknown): value is WorkspaceOrchestrationIndexItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "kind",
      "id",
      "fingerprint",
      "status",
      "updatedAt",
      "costUsd",
      "tokensUsed",
      "activeDurationMs",
      "failures",
      "parent",
    ]) &&
    (value.kind === "loop" || value.kind === "graph") &&
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_RE.test(value.fingerprint) &&
    typeof value.status === "string" &&
    value.status.length > 0 &&
    value.status.length <= 64 &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    Number.isSafeInteger(value.tokensUsed) &&
    (value.tokensUsed as number) >= 0 &&
    Number.isSafeInteger(value.activeDurationMs) &&
    (value.activeDurationMs as number) >= 0 &&
    Number.isSafeInteger(value.failures) &&
    (value.failures as number) >= 0 &&
    (value.parent === undefined ||
      (isRecord(value.parent) &&
        hasOnlyKeys(value.parent, ["graphId", "nodeId"]) &&
        typeof value.parent.graphId === "string" &&
        ID_RE.test(value.parent.graphId) &&
        typeof value.parent.nodeId === "string" &&
        ID_RE.test(value.parent.nodeId)))
  );
}

function parseIndex(raw: string): WorkspaceOrchestrationIndex | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "generation", "generatedAt", "totals", "items"]) ||
      value.version !== 1 ||
      typeof value.generation !== "string" ||
      !FINGERPRINT_RE.test(value.generation) ||
      typeof value.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.generatedAt)) ||
      !isRecord(value.totals) ||
      !hasOnlyKeys(value.totals, ["loops", "graphs", "costUsd", "tokensUsed", "activeDurationMs", "failures"]) ||
      !Number.isSafeInteger(value.totals.loops) ||
      (value.totals.loops as number) < 0 ||
      !Number.isSafeInteger(value.totals.graphs) ||
      (value.totals.graphs as number) < 0 ||
      typeof value.totals.costUsd !== "number" ||
      !Number.isFinite(value.totals.costUsd) ||
      value.totals.costUsd < 0 ||
      !Number.isSafeInteger(value.totals.tokensUsed) ||
      (value.totals.tokensUsed as number) < 0 ||
      !Number.isSafeInteger(value.totals.activeDurationMs) ||
      (value.totals.activeDurationMs as number) < 0 ||
      !Number.isSafeInteger(value.totals.failures) ||
      (value.totals.failures as number) < 0 ||
      !isDenseArray(value.items) ||
      value.items.length > MAX_ITEMS ||
      !value.items.every(validItem) ||
      new Set(value.items.map((item) => `${item.kind}\0${item.id}`)).size !== value.items.length
    ) {
      return undefined;
    }
    return value as WorkspaceOrchestrationIndex;
  } catch {
    return undefined;
  }
}

export function readWorkspaceOrchestrationIndex(workspace: string): WorkspaceOrchestrationIndex | undefined {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  return raw === undefined ? undefined : parseIndex(raw);
}

/** Builds a bounded materialized summary from already validated checkpoint owners. */
function refreshWorkspaceOrchestrationIndexUnlocked(workspace: string): WorkspaceOrchestrationIndex {
  const loops = listLoopStates(workspace);
  const graphs = listWorkspaceEngineeringGraphTreeStates(workspace);
  const allItems: WorkspaceOrchestrationIndexItem[] = [
    ...loops.map((loop) => ({
      kind: "loop" as const,
      id: loop.loopId,
      fingerprint: loopOrchestrationFingerprint(loop),
      status: loop.status,
      updatedAt: loop.updatedAt,
      costUsd: loop.costUsd,
      tokensUsed: loop.tokensUsed ?? 0,
      activeDurationMs: loop.elapsedMs ?? 0,
      failures: loop.lastVerify?.code === 0 ? 0 : (loop.snapshots?.at(-1)?.failedTests ?? 1),
      ...(loop.parentGraph ? { parent: loop.parentGraph } : {}),
    })),
    ...graphs.map((graph) => ({
      kind: "graph" as const,
      id: graph.graphId,
      fingerprint: graph.fingerprint,
      status: graph.status,
      updatedAt: graph.updatedAt,
      costUsd: graph.spentCost,
      tokensUsed: graph.spentTokens,
      activeDurationMs: graph.elapsedMs,
      failures: graph.results.filter((result) => result.status === "failed").length,
      ...(graph.parentGraph ? { parent: graph.parentGraph } : {}),
    })),
  ].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || compareByCodePoints(left.id, right.id),
  );
  const items = allItems.slice(0, MAX_ITEMS);
  const totals = allItems.reduce(
    (summary, item) => ({
      loops: summary.loops + (item.kind === "loop" ? 1 : 0),
      graphs: summary.graphs + (item.kind === "graph" ? 1 : 0),
      costUsd: summary.costUsd + item.costUsd,
      tokensUsed: summary.tokensUsed + item.tokensUsed,
      activeDurationMs: summary.activeDurationMs + item.activeDurationMs,
      failures: summary.failures + item.failures,
    }),
    { loops: 0, graphs: 0, costUsd: 0, tokensUsed: 0, activeDurationMs: 0, failures: 0 },
  );
  const generation = createHash("sha256").update(JSON.stringify({ allItems, totals })).digest("hex");
  const index: WorkspaceOrchestrationIndex = {
    version: 1,
    generation,
    generatedAt: new Date().toISOString(),
    totals,
    items,
  };
  const serialized = `${JSON.stringify(index)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Orchestration index exceeds the durable byte limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
  return index;
}

/** Serializes the source scan with publication so an older refresh cannot win last. */
export function refreshWorkspaceOrchestrationIndex(workspace: string): WorkspaceOrchestrationIndex {
  const lease = acquireSessionLease(workspace, "orchestration-index");
  try {
    return refreshWorkspaceOrchestrationIndexUnlocked(workspace);
  } finally {
    lease.release();
  }
}
