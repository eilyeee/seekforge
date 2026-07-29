import { createHash } from "node:crypto";
import type { EngineeringGraphEvidenceReport } from "@seekforge/shared";
import { isRecord } from "../util/guards.js";
import type { EngineeringGraphState } from "./graph-state.js";

export function buildEngineeringGraphEvidenceReport(
  state: EngineeringGraphState,
  now = new Date(),
): EngineeringGraphEvidenceReport {
  const report: Omit<EngineeringGraphEvidenceReport, "integrity"> = {
    schemaVersion: 1,
    graphId: state.graphId,
    fingerprint: state.fingerprint,
    generatedAt: now.toISOString(),
    status: state.status,
    usage: { costUsd: state.spentCost, tokensUsed: state.spentTokens },
    nodes: state.results.map(
      ({
        id,
        kind,
        status,
        attempts,
        costUsd,
        tokensUsed,
        startedAt,
        completedAt,
        error,
        managedBranch,
        artifacts,
      }) => ({
        id,
        kind,
        status,
        attempts,
        costUsd,
        tokensUsed,
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(error ? { error } : {}),
        ...(managedBranch ? { managedBranch } : {}),
        ...(artifacts ? { artifacts } : {}),
      }),
    ),
    retainedEventCount: state.events.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    ...(state.parentGraph ? { parentGraph: state.parentGraph } : {}),
    ...(state.resourceGeneration ? { resourceGeneration: state.resourceGeneration } : {}),
    ...(state.fanIn
      ? {
          fanIn: {
            status: state.fanIn.status,
            branch: state.fanIn.branch,
            costUsd: state.fanIn.costUsd,
            tokensUsed: state.fanIn.tokensUsed,
            updatedAt: state.fanIn.updatedAt,
            ...(state.fanIn.error ? { error: state.fanIn.error } : {}),
          },
        }
      : {}),
  };
  return {
    ...report,
    integrity: { algorithm: "sha256", digest: createHash("sha256").update(JSON.stringify(report)).digest("hex") },
  };
}

export function verifyEngineeringGraphEvidenceIntegrity(report: unknown): boolean {
  if (!isRecord(report) || !isRecord(report.integrity)) return false;
  if (
    report.integrity.algorithm !== "sha256" ||
    typeof report.integrity.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(report.integrity.digest)
  ) {
    return false;
  }
  const { integrity, ...payload } = report;
  try {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex") === integrity.digest;
  } catch {
    return false;
  }
}
