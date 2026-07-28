import { createHash } from "node:crypto";
import { isRecord } from "../util/guards.js";
import type { LoopState } from "./loop-state.js";

export type LoopEvidenceFormat = "json" | "sarif" | "junit";

export type LoopEvidenceReport = {
  schemaVersion: 1;
  loopId: string;
  generatedAt: string;
  status: LoopState["status"];
  workspace: string;
  task: string;
  usage: { costUsd: number; tokensUsed: number; iterations: number };
  criteria: Array<{
    id: string;
    text: string;
    requirementIds: string[];
    status: "met" | "unmet" | "unknown";
    evidence: string[];
  }>;
  verification: Array<{
    id: string;
    command: string;
    required: boolean;
    code?: number;
    attempts?: number;
    durationMs?: number;
    flaky?: boolean;
    selection?: "full" | "direct" | "dependency" | "cached";
    matchedPaths?: string[];
  }>;
  iterations: Array<{
    iteration: number;
    ts: string;
    failedTests: number;
    durationMs?: number;
    costUsd?: number;
    tokensUsed?: number;
    failureCategory?: string;
    rolledBack?: boolean;
  }>;
  delivery?: LoopState["delivery"];
  integrity: { algorithm: "sha256"; digest: string; revision?: string };
};

export type LoopEvidenceComparison = {
  leftLoopId: string;
  rightLoopId: string;
  statusChanged: boolean;
  costDeltaUsd: number;
  iterationDelta: number;
  criteriaChanged: string[];
  verificationChanged: string[];
};

/** Builds a bounded requirement → verification → immutable delivery evidence view. */
export function buildLoopEvidenceReport(state: LoopState, now = new Date()): LoopEvidenceReport {
  const reviews = new Map(state.acceptanceReview?.criteria.map((criterion) => [criterion.id, criterion]) ?? []);
  const stages = new Map(state.stageResults?.map((stage) => [stage.id, stage]) ?? []);
  const plan = state.verificationPlan ?? [{ id: "verify", command: state.verifyCommand }];
  const report: Omit<LoopEvidenceReport, "integrity"> = {
    schemaVersion: 1,
    loopId: state.loopId,
    generatedAt: now.toISOString(),
    status: state.status,
    workspace: state.workspace,
    task: state.task,
    usage: { costUsd: state.costUsd, tokensUsed: state.tokensUsed ?? 0, iterations: state.iterations },
    criteria: (state.requirements?.acceptanceCriteria ?? []).map((criterion) => {
      const review = reviews.get(criterion.id);
      return {
        id: criterion.id,
        text: criterion.text,
        requirementIds: [...criterion.requirementIds],
        status: review?.status ?? "unknown",
        evidence: [...(review?.evidence ?? [])],
      };
    }),
    verification: plan.map((stage) => {
      const result = stages.get(stage.id);
      return {
        id: stage.id,
        command: stage.command,
        required: stage.required !== false,
        ...(result
          ? {
              code: result.code,
              attempts: result.attempts,
              durationMs: result.durationMs,
              flaky: result.flaky,
              ...(result.selection ? { selection: result.selection } : {}),
              ...(result.matchedPaths ? { matchedPaths: [...result.matchedPaths] } : {}),
            }
          : {}),
      };
    }),
    iterations: (state.snapshots ?? []).map((snapshot) => ({
      iteration: snapshot.iteration,
      ts: snapshot.ts,
      failedTests: snapshot.failedTests,
      ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
      ...(snapshot.costUsd !== undefined ? { costUsd: snapshot.costUsd } : {}),
      ...(snapshot.tokensUsed !== undefined ? { tokensUsed: snapshot.tokensUsed } : {}),
      ...(snapshot.failureCategory ? { failureCategory: snapshot.failureCategory } : {}),
      ...(snapshot.rolledBack ? { rolledBack: true } : {}),
    })),
    ...(state.delivery ? { delivery: state.delivery } : {}),
  };
  const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const revision = state.delivery?.evidence?.revision;
  return {
    ...report,
    integrity: { algorithm: "sha256", digest, ...(revision ? { revision } : {}) },
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function exportLoopEvidence(report: LoopEvidenceReport, format: LoopEvidenceFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "sarif") {
    const results = [
      ...report.criteria
        .filter((item) => item.status !== "met")
        .map((item) => ({
          ruleId: `acceptance/${item.id}`,
          level: item.status === "unmet" ? "error" : "warning",
          message: { text: item.text },
        })),
      ...report.verification
        .filter((item) => item.required && item.code !== 0)
        .map((item) => ({
          ruleId: `verification/${item.id}`,
          level: item.code === undefined ? "warning" : "error",
          message: {
            text: item.code === undefined ? `${item.command} has no result` : `${item.command} exited ${item.code}`,
          },
        })),
    ];
    return `${JSON.stringify({ version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{ tool: { driver: { name: "SeekForge Loop", version: "1" } }, results }] }, null, 2)}\n`;
  }
  const cases = [
    ...report.criteria.map(
      (item) =>
        `<testcase classname="acceptance" name="${xml(item.id)}">${item.status === "met" ? "" : `<failure message="${xml(item.status)}">${xml(item.text)}</failure>`}</testcase>`,
    ),
    ...report.verification.map(
      (item) =>
        `<testcase classname="verification" name="${xml(item.id)}">${item.required && item.code !== 0 ? `<failure message="${item.code === undefined ? "missing result" : `exit ${item.code}`}">${xml(item.command)}</failure>` : ""}</testcase>`,
    ),
  ];
  const failures = cases.filter((item) => item.includes("<failure")).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="SeekForge Loop ${xml(report.loopId)}" tests="${cases.length}" failures="${failures}">${cases.join("")}</testsuite>\n`;
}

export function verifyLoopEvidenceIntegrity(report: unknown): boolean {
  if (!isRecord(report) || !isRecord(report.integrity)) return false;
  const integrity = report.integrity;
  if (
    integrity.algorithm !== "sha256" ||
    typeof integrity.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.digest)
  ) {
    return false;
  }
  const { integrity: _integrity, ...payload } = report;
  try {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex") === integrity.digest;
  } catch {
    return false;
  }
}

export function compareLoopEvidence(left: LoopEvidenceReport, right: LoopEvidenceReport): LoopEvidenceComparison {
  const criterionValue = (item: LoopEvidenceReport["criteria"][number]): string =>
    JSON.stringify([item.text, item.requirementIds, item.status, item.evidence]);
  const verificationValue = (item: LoopEvidenceReport["verification"][number]): string =>
    JSON.stringify([
      item.command,
      item.required,
      item.code,
      item.attempts,
      item.durationMs,
      item.flaky,
      item.selection,
      item.matchedPaths,
    ]);
  const leftCriteria = new Map(left.criteria.map((item) => [item.id, criterionValue(item)]));
  const rightCriteria = new Map(right.criteria.map((item) => [item.id, criterionValue(item)]));
  const leftVerification = new Map(left.verification.map((item) => [item.id, verificationValue(item)]));
  const rightVerification = new Map(right.verification.map((item) => [item.id, verificationValue(item)]));
  const criteriaChanged = [...new Set([...leftCriteria.keys(), ...rightCriteria.keys()])].filter(
    (id) => leftCriteria.get(id) !== rightCriteria.get(id),
  );
  const verificationChanged = [...new Set([...leftVerification.keys(), ...rightVerification.keys()])].filter(
    (id) => leftVerification.get(id) !== rightVerification.get(id),
  );
  return {
    leftLoopId: left.loopId,
    rightLoopId: right.loopId,
    statusChanged: left.status !== right.status,
    costDeltaUsd: right.usage.costUsd - left.usage.costUsd,
    iterationDelta: right.iterations.length - left.iterations.length,
    criteriaChanged,
    verificationChanged,
  };
}
