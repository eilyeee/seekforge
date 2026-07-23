/**
 * Conservative, deterministic project-memory maintenance.
 *
 * Automatic maintenance is opt-in. Once enabled, it runs only when project
 * memory crosses a size/count threshold and the persisted minimum interval has
 * elapsed. Compaction itself is the existing deterministic implementation; no
 * model call is involved, and stale facts are archived only when the user
 * explicitly configures pruneUnusedDays.
 */

import { join } from "node:path";
import type { MemoryMaintenanceConfig, MemoryMaintenanceState } from "@seekforge/shared";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { compactProjectMemory, type CompactResult } from "./compact.js";
import {
  MAX_MEMORY_DOCUMENT_BYTES,
  MemoryStateCorruptError,
  readRawProjectMemory,
  withMemoryTransaction,
} from "./store.js";

export const DEFAULT_MEMORY_MAINTENANCE_MIN_FACTS = 100;
export const DEFAULT_MEMORY_MAINTENANCE_MIN_BYTES = 64 * 1024;
export const DEFAULT_MEMORY_MAINTENANCE_INTERVAL_HOURS = 24;
export const MAX_MEMORY_MAINTENANCE_STATE_BYTES = 16 * 1024;

const STATE_REL_PATH = ".seekforge/memory/maintenance.json";
const CONFIG_KEYS = new Set(["enabled", "minFacts", "minBytes", "minIntervalHours", "pruneUnusedDays"]);

export type { MemoryMaintenanceConfig } from "@seekforge/shared";

export type ResolvedMemoryMaintenanceConfig = {
  enabled: boolean;
  minFacts: number;
  minBytes: number;
  minIntervalHours: number;
  pruneUnusedDays?: number;
};

export type { MemoryMaintenanceState } from "@seekforge/shared";

export type MemoryMaintenanceOutcome =
  | { status: "disabled" | "below_threshold" | "throttled" }
  | { status: "completed"; state: MemoryMaintenanceState; result: CompactResult }
  | { status: "failed"; error: string };

function positiveSafeInteger(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${max}`);
  }
  return value as number;
}

function boundedNonNegativeNumber(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be a finite number between 0 and ${max}`);
  }
  return value;
}

/** Validates untrusted config and fills conservative defaults. */
export function resolveMemoryMaintenanceConfig(value: unknown): ResolvedMemoryMaintenanceConfig {
  if (value === undefined) {
    return {
      enabled: false,
      minFacts: DEFAULT_MEMORY_MAINTENANCE_MIN_FACTS,
      minBytes: DEFAULT_MEMORY_MAINTENANCE_MIN_BYTES,
      minIntervalHours: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_HOURS,
    };
  }
  if (!isRecord(value)) throw new RangeError("memoryMaintenance must be an object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new RangeError(`unknown memoryMaintenance key: ${key}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new RangeError("memoryMaintenance.enabled must be true or false");
  }
  const minFacts =
    value.minFacts === undefined
      ? DEFAULT_MEMORY_MAINTENANCE_MIN_FACTS
      : positiveSafeInteger(value.minFacts, "memoryMaintenance.minFacts", 1_000_000);
  const minBytes =
    value.minBytes === undefined
      ? DEFAULT_MEMORY_MAINTENANCE_MIN_BYTES
      : positiveSafeInteger(value.minBytes, "memoryMaintenance.minBytes", MAX_MEMORY_DOCUMENT_BYTES);
  const minIntervalHours =
    value.minIntervalHours === undefined
      ? DEFAULT_MEMORY_MAINTENANCE_INTERVAL_HOURS
      : boundedNonNegativeNumber(value.minIntervalHours, "memoryMaintenance.minIntervalHours", 8_760);
  const pruneUnusedDays =
    value.pruneUnusedDays === undefined
      ? undefined
      : boundedNonNegativeNumber(value.pruneUnusedDays, "memoryMaintenance.pruneUnusedDays", 36_500);
  return {
    enabled: value.enabled === true,
    minFacts,
    minBytes,
    minIntervalHours,
    ...(pruneUnusedDays !== undefined ? { pruneUnusedDays } : {}),
  };
}

function resultSummary(result: CompactResult): MemoryMaintenanceState["lastResult"] {
  return {
    before: result.before,
    after: result.after,
    removed: result.removed.length,
    merged: result.merged.length,
    archived: result.archived.length,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseState(raw: string): MemoryMaintenanceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryStateCorruptError(STATE_REL_PATH, "invalid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.lastRunAt !== "string") {
    throw new MemoryStateCorruptError(STATE_REL_PATH, "invalid state shape");
  }
  const epoch = Date.parse(parsed.lastRunAt);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== parsed.lastRunAt || !isRecord(parsed.lastResult)) {
    throw new MemoryStateCorruptError(STATE_REL_PATH, "invalid last run metadata");
  }
  const result = parsed.lastResult;
  if (
    !isNonNegativeSafeInteger(result.before) ||
    !isNonNegativeSafeInteger(result.after) ||
    !isNonNegativeSafeInteger(result.removed) ||
    !isNonNegativeSafeInteger(result.merged) ||
    !isNonNegativeSafeInteger(result.archived)
  ) {
    throw new MemoryStateCorruptError(STATE_REL_PATH, "invalid result counters");
  }
  return {
    version: 1,
    lastRunAt: parsed.lastRunAt,
    lastResult: {
      before: result.before,
      after: result.after,
      removed: result.removed,
      merged: result.merged,
      archived: result.archived,
    },
  };
}

export function memoryMaintenanceStatePath(workspace: string): string {
  return join(workspace, STATE_REL_PATH);
}

/** Read-only status view; malformed state is omitted rather than exposed. */
export function readMemoryMaintenanceState(workspace: string): MemoryMaintenanceState | undefined {
  try {
    const raw = readWorkspaceStateFile(workspace, STATE_REL_PATH, MAX_MEMORY_MAINTENANCE_STATE_BYTES);
    return raw === undefined ? undefined : parseState(raw);
  } catch {
    return undefined;
  }
}

/**
 * Runs maintenance when due. Every failure is converted to a result so callers
 * can keep the user operation successful; corrupt/oversized state is preserved.
 */
export function maybeMaintainProjectMemory(
  workspace: string,
  config: MemoryMaintenanceConfig | undefined,
  now = new Date(),
): MemoryMaintenanceOutcome {
  try {
    const resolved = resolveMemoryMaintenanceConfig(config);
    if (!resolved.enabled) return { status: "disabled" };
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new RangeError("memory maintenance time must be valid");

    return withMemoryTransaction(workspace, () => {
      const raw = readRawProjectMemory(workspace) ?? "";
      const factCount = raw.split("\n").filter((line) => line.trim().startsWith("- ")).length;
      const bytes = Buffer.byteLength(raw, "utf8");
      if (factCount < resolved.minFacts && bytes < resolved.minBytes) return { status: "below_threshold" };

      const stateRaw = readWorkspaceStateFile(workspace, STATE_REL_PATH, MAX_MEMORY_MAINTENANCE_STATE_BYTES);
      if (stateRaw !== undefined) {
        const state = parseState(stateRaw);
        const lastRunMs = Date.parse(state.lastRunAt);
        const intervalMs = resolved.minIntervalHours * 60 * 60 * 1000;
        if (nowMs - lastRunMs < intervalMs) return { status: "throttled" };
      }

      const result = compactProjectMemory(workspace, {
        ...(resolved.pruneUnusedDays !== undefined ? { pruneUnusedDays: resolved.pruneUnusedDays } : {}),
      });
      const state: MemoryMaintenanceState = {
        version: 1,
        lastRunAt: new Date(nowMs).toISOString(),
        lastResult: resultSummary(result),
      };
      writeWorkspaceStateFileAtomic(workspace, STATE_REL_PATH, `${JSON.stringify(state, null, 2)}\n`);
      return { status: "completed", state, result };
    });
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
