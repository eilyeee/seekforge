import { isRecord } from "../util/guards.js";
import { isDenseArray } from "./orchestration.js";
import { isSafeLoopDagRelativePath, isValidLoopDagId } from "./loop-dag-validation.js";
import type { LoopCodeReview, LoopCodeReviewFinding, LoopWorkingMemory } from "@seekforge/shared";
export type { LoopCodeReview, LoopCodeReviewFinding, LoopWorkingMemory } from "@seekforge/shared";

const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKING_MEMORY_KEYS = new Set([
  "iteration",
  "updatedAt",
  "workspaceFingerprint",
  "failureCategory",
  "failedTests",
  "changedPaths",
  "acceptanceGaps",
  "reviewFindings",
]);

export function parseLoopCodeReview(value: unknown): LoopCodeReview | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const source = fenced?.[1] ?? trimmed;
    if (source.length > 64_000) return null;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "complete" && key !== "summary" && key !== "findings") ||
    typeof value.complete !== "boolean" ||
    typeof value.summary !== "string" ||
    value.summary.length > 8_192 ||
    !isDenseArray(value.findings) ||
    value.findings.length > 32
  ) {
    return null;
  }
  const findings: LoopCodeReviewFinding[] = [];
  const ids = new Set<string>();
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      Object.keys(finding).some((key) => !["id", "priority", "title", "body", "file", "line"].includes(key)) ||
      typeof finding.id !== "string" ||
      !FINDING_ID_RE.test(finding.id) ||
      ids.has(finding.id) ||
      !Number.isSafeInteger(finding.priority) ||
      (finding.priority as number) < 0 ||
      (finding.priority as number) > 3 ||
      typeof finding.title !== "string" ||
      !finding.title.trim() ||
      finding.title.length > 256 ||
      typeof finding.body !== "string" ||
      !finding.body.trim() ||
      finding.body.length > 4_096 ||
      (finding.file !== undefined &&
        (typeof finding.file !== "string" || !finding.file.trim() || finding.file.length > 1_024)) ||
      (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || (finding.line as number) < 1))
    ) {
      return null;
    }
    ids.add(finding.id);
    findings.push(finding as LoopCodeReviewFinding);
  }
  const reviewTextLength =
    value.summary.length + findings.reduce((total, finding) => total + finding.title.length + finding.body.length, 0);
  if (value.complete !== (findings.length === 0) || reviewTextLength > 48_000) return null;
  return { complete: value.complete, summary: value.summary, findings };
}

export function buildLoopCodeReviewPrompt(task: string, verifyCommand: string): string {
  return [
    "Perform an independent code review of the current workspace after implementation and verification.",
    "Start fresh from the final diff and the original request. Do not assume the implementation approach is correct.",
    "Review correctness, regressions, security boundaries, async/state/resource lifecycles, tests, and documentation.",
    "Use read-only tools only. Do not edit files, run mutating commands, or delegate implementation.",
    `Original request: ${JSON.stringify(task)}`,
    `Authoritative verifier: ${JSON.stringify(verifyCommand)}`,
    "Return JSON only with this exact shape:",
    '{"complete":boolean,"summary":string,"findings":[{"id":string,"priority":0|1|2|3,"title":string,"body":string,"file"?:string,"line"?:number}]}',
    "complete must be true exactly when findings is empty. Include only concrete, actionable findings.",
  ].join("\n\n");
}

export function formatLoopCodeReviewGaps(review: LoopCodeReview): string {
  return review.findings
    .map(
      (finding) =>
        `[${finding.id}/P${finding.priority}] ${finding.title}: ${finding.body}${
          finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""
        }`,
    )
    .join("\n");
}

export function createLoopWorkingMemory(input: Omit<LoopWorkingMemory, "updatedAt">): LoopWorkingMemory {
  return {
    ...input,
    failureCategory: new Set([
      "none",
      "test",
      "compile",
      "lint",
      "review",
      "environment",
      "timeout",
      "permission",
      "network",
      "unknown",
    ]).has(input.failureCategory)
      ? input.failureCategory
      : "unknown",
    changedPaths: [...new Set(input.changedPaths)]
      .filter((path) => path.length <= 1_024 && isSafeLoopDagRelativePath(path))
      .slice(0, 128),
    acceptanceGaps: [...new Set(input.acceptanceGaps)]
      .filter((id) => id.length <= 1_024 && isValidLoopDagId(id))
      .slice(0, 32),
    reviewFindings: [...new Set(input.reviewFindings)]
      .filter((id) => id.length <= 1_024 && FINDING_ID_RE.test(id))
      .slice(0, 32),
    updatedAt: new Date().toISOString(),
  };
}

export function parseLoopWorkingMemory(value: unknown): LoopWorkingMemory | null {
  const failureCategories = new Set([
    "none",
    "test",
    "compile",
    "lint",
    "review",
    "environment",
    "timeout",
    "permission",
    "network",
    "unknown",
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !WORKING_MEMORY_KEYS.has(key)) ||
    !Number.isSafeInteger(value.iteration) ||
    (value.iteration as number) < 0 ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.workspaceFingerprint !== null &&
      (typeof value.workspaceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.workspaceFingerprint))) ||
    typeof value.failureCategory !== "string" ||
    !failureCategories.has(value.failureCategory) ||
    !Number.isSafeInteger(value.failedTests) ||
    (value.failedTests as number) < 0
  ) {
    return null;
  }
  if (
    !isDenseArray(value.changedPaths) ||
    value.changedPaths.length > 128 ||
    !isDenseArray(value.acceptanceGaps) ||
    value.acceptanceGaps.length > 32 ||
    !isDenseArray(value.reviewFindings) ||
    value.reviewFindings.length > 32 ||
    [value.changedPaths, value.acceptanceGaps, value.reviewFindings].some((items) =>
      items.some((item) => typeof item !== "string" || item.length > 1_024),
    )
  ) {
    return null;
  }
  if (
    !(value.changedPaths as unknown[]).every(isSafeLoopDagRelativePath) ||
    !(value.acceptanceGaps as unknown[]).every(isValidLoopDagId) ||
    !(value.reviewFindings as unknown[]).every((item) => typeof item === "string" && FINDING_ID_RE.test(item)) ||
    new Set(value.changedPaths).size !== value.changedPaths.length ||
    new Set(value.acceptanceGaps).size !== value.acceptanceGaps.length ||
    new Set(value.reviewFindings).size !== value.reviewFindings.length
  ) {
    return null;
  }
  return value as LoopWorkingMemory;
}
