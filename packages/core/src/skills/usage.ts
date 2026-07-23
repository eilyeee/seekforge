import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { acquireSessionLease } from "../agent/session-lease.js";
import { writeAllSync } from "../util/fs.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { SKILL_ID_RE } from "./storage.js";
import type { SkillEffectiveness, SkillSelection } from "./types.js";

export const MAX_SKILL_USAGE_BYTES = 8 * 1024 * 1024;
const RETAIN_SKILL_USAGE_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_REASON_CHARS = 2_000;
const USAGE_REL_PATH = path.join(".seekforge", "skills-usage.jsonl");

function appendUsageRecords(workspace: string, records: readonly Record<string, unknown>[]): void {
  if (records.length === 0) return;
  // Observability is best-effort: a corrupt/link/FIFO usage target must never
  // fail or block the foreground Agent run.
  let lease: ReturnType<typeof acquireSessionLease> | undefined;
  let fd: number | undefined;
  try {
    lease = acquireSessionLease(workspace, "skills-usage");
    const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    const bytes = Buffer.from(lines, "utf8");
    if (bytes.length > MAX_SKILL_USAGE_BYTES) return;

    const root = realpathSync(workspace);
    const target = path.join(root, USAGE_REL_PATH);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing === undefined) {
      writeWorkspaceStateFileAtomic(root, USAGE_REL_PATH, "");
    } else if (existing.isSymbolicLink() || !existing.isFile() || existing.size > MAX_SKILL_USAGE_BYTES) {
      return;
    } else if (existing.size + bytes.length > MAX_SKILL_USAGE_BYTES) {
      const raw = readWorkspaceStateFile(root, USAGE_REL_PATH, MAX_SKILL_USAGE_BYTES);
      if (raw === undefined) return;
      const start = Math.max(0, raw.length - RETAIN_SKILL_USAGE_BYTES);
      const newline = start === 0 ? -1 : raw.indexOf("\n", start);
      const boundary = start === 0 ? 0 : newline === -1 ? raw.length : newline + 1;
      writeWorkspaceStateFileAtomic(root, USAGE_REL_PATH, raw.slice(boundary));
    }

    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return;
    writeAllSync(fd, bytes);
  } catch {
    // Best-effort usage telemetry only.
  } finally {
    if (fd !== undefined) closeSync(fd);
    lease?.release();
  }
}

/** Appends one JSONL entry per selection to .seekforge/skills-usage.jsonl. */
export function logSkillUsage(workspace: string, sessionId: string, selections: SkillSelection[]): void {
  const ts = new Date().toISOString();
  appendUsageRecords(
    workspace,
    selections.map((sel) => ({
      type: "selection",
      ts,
      sessionId: sessionId.slice(0, 128),
      skillId: sel.skill.id,
      scope: sel.skill.scope,
      score: sel.score,
      reason: sel.reason.slice(0, MAX_USAGE_REASON_CHARS),
      ...(sel.feedbackAdjustment !== undefined ? { feedbackAdjustment: sel.feedbackAdjustment } : {}),
    })),
  );
}

export type SkillOutcome = {
  success: boolean;
  /** Present when a configured verifier had a meaningful result. */
  verified?: boolean;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
};

/** Records one bounded terminal outcome for every skill exposed in a session. */
export function logSkillOutcome(
  workspace: string,
  sessionId: string,
  skillIds: readonly string[],
  outcome: SkillOutcome,
): void {
  const ts = new Date().toISOString();
  const ids = [...new Set(skillIds.filter((id) => SKILL_ID_RE.test(id)))].slice(0, 64);
  appendUsageRecords(
    workspace,
    ids.map((skillId) => ({
      type: "outcome",
      ts,
      sessionId: sessionId.slice(0, 128),
      skillId,
      success: outcome.success,
      ...(typeof outcome.verified === "boolean" ? { verified: outcome.verified } : {}),
      ...(Number.isSafeInteger(outcome.turns) && outcome.turns! >= 0
        ? { turns: Math.min(outcome.turns!, 10_000) }
        : {}),
      ...(Number.isSafeInteger(outcome.toolCalls) && outcome.toolCalls! >= 0
        ? { toolCalls: Math.min(outcome.toolCalls!, 1_000_000) }
        : {}),
      ...(Number.isFinite(outcome.costUsd) && outcome.costUsd! >= 0
        ? { costUsd: Math.min(outcome.costUsd!, 1_000_000) }
        : {}),
    })),
  );
}

/** Returns the bounded set of skills selected for one session across resumed turns. */
export function selectedSkillIdsForSession(workspace: string, sessionId: string): string[] {
  let raw: string | undefined;
  try {
    raw = readWorkspaceStateFile(realpathSync(workspace), USAGE_REL_PATH, MAX_SKILL_USAGE_BYTES);
  } catch {
    return [];
  }
  if (!raw) return [];
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.type === "selection" &&
        row.sessionId === sessionId &&
        typeof row.skillId === "string" &&
        SKILL_ID_RE.test(row.skillId)
      ) {
        ids.add(row.skillId);
        if (ids.size >= 64) break;
      }
    } catch {
      break;
    }
  }
  return [...ids];
}

type MutableEffectiveness = {
  selections: Set<string>;
  outcomes: Map<string, { success: boolean; verified?: boolean; turns?: number; toolCalls?: number; costUsd?: number }>;
};

/** Reads bounded local telemetry and derives conservative, non-authoritative weights. */
export function readSkillEffectiveness(workspace: string): SkillEffectiveness[] {
  let raw: string | undefined;
  try {
    raw = readWorkspaceStateFile(realpathSync(workspace), USAGE_REL_PATH, MAX_SKILL_USAGE_BYTES);
  } catch {
    return [];
  }
  if (raw === undefined) return [];
  const bySkill = new Map<string, MutableEffectiveness>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.skillId !== "string" || !SKILL_ID_RE.test(row.skillId)) continue;
      if (typeof row.sessionId !== "string" || row.sessionId.length > 128) continue;
      const stats = bySkill.get(row.skillId) ?? { selections: new Set(), outcomes: new Map() };
      if (row.type === "outcome" && typeof row.success === "boolean") {
        stats.outcomes.set(row.sessionId, {
          success: row.success,
          ...(typeof row.verified === "boolean" ? { verified: row.verified } : {}),
          ...(typeof row.turns === "number" && Number.isFinite(row.turns) && row.turns >= 0
            ? { turns: row.turns }
            : {}),
          ...(typeof row.toolCalls === "number" && Number.isFinite(row.toolCalls) && row.toolCalls >= 0
            ? { toolCalls: row.toolCalls }
            : {}),
          ...(typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0
            ? { costUsd: row.costUsd }
            : {}),
        });
      } else if (row.type === "selection" || row.type === undefined) {
        stats.selections.add(row.sessionId);
      }
      bySkill.set(row.skillId, stats);
    } catch {
      // Corrupt telemetry is ignored row-by-row.
    }
  }
  return [...bySkill.entries()]
    .map(([skillId, value]): SkillEffectiveness => {
      const outcomes = [...value.outcomes.values()];
      const successes = outcomes.filter((outcome) => outcome.success && outcome.verified !== false).length;
      const completedOutcomes = outcomes.length;
      const successRate = completedOutcomes > 0 ? successes / completedOutcomes : undefined;
      const toolCalls = outcomes.flatMap((outcome) => (outcome.toolCalls === undefined ? [] : [outcome.toolCalls]));
      const turns = outcomes.flatMap((outcome) => (outcome.turns === undefined ? [] : [outcome.turns]));
      const costs = outcomes.flatMap((outcome) => (outcome.costUsd === undefined ? [] : [outcome.costUsd]));
      const confidence = completedOutcomes < 3 ? 0 : completedOutcomes / (completedOutcomes + 10);
      const learnedAdjustment =
        successRate === undefined ? 0 : Math.max(-0.75, Math.min(0.75, (successRate - 0.5) * 1.5 * confidence));
      return {
        skillId,
        selections: value.selections.size,
        completedOutcomes,
        successes,
        ...(successRate !== undefined ? { successRate } : {}),
        ...(toolCalls.length > 0
          ? { averageToolCalls: toolCalls.reduce((sum, count) => sum + count, 0) / toolCalls.length }
          : {}),
        ...(turns.length > 0 ? { averageTurns: turns.reduce((sum, count) => sum + count, 0) / turns.length } : {}),
        ...(costs.length > 0 ? { averageCostUsd: costs.reduce((sum, cost) => sum + cost, 0) / costs.length } : {}),
        learnedAdjustment,
      };
    })
    .sort((a, b) => b.selections - a.selections || a.skillId.localeCompare(b.skillId));
}
