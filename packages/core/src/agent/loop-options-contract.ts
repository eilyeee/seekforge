/**
 * Pure contract checks for Loop options — no effects, no imports from the
 * engine, so either side can run the complete check while it is still cheap to
 * fail.
 *
 * Two callers need the same rules at two different moments and neither can
 * wait for the other: `runAutoLoop` must finish validating before it takes a
 * lifecycle lease, resolves providers, persists state or provisions a
 * worktree, and `parseGraphLoopOptions` must reject an unrunnable `loop` node
 * while the graph definition parse is still pure — long before a run exists.
 * That is why the rules live here instead of one call site borrowing the
 * other's: sharing the *implementation* must not move either check later.
 *
 * The two surfaces are deliberately not identical, and the differences are
 * arguments rather than forks:
 *  - `rejectUnknownFields` — a graph definition is authored text where a typo
 *    should be a hard error; the engine also accepts a plan replayed from
 *    persisted resume state, which a newer version may have written with
 *    fields this one does not know.
 *  - `maxTimeoutMs` — the graph layer bounds every declared duration; the
 *    programmatic engine API only requires a positive safe integer.
 * Everything else is one rule with one owner.
 */

// Type-only, so this stays effect-free and creates no runtime cycle with the
// engine module that declares the public stage shape.
import type { LoopVerificationStage } from "./auto-loop.js";
import { isRecord } from "../util/guards.js";
import { isVerificationPathPrefix } from "./loop-verification-selection.js";
import { isDenseArray } from "./orchestration.js";
import { isValidOrchestrationResourceId } from "./orchestration-scheduler.js";

/** Stages one verification plan may declare. */
export const MAX_LOOP_VERIFICATION_STAGES = 16;
/** Path prefixes one stage may declare in `paths` / `dependencyPaths`. */
export const MAX_LOOP_VERIFICATION_STAGE_PATHS = 64;
/** Named resources one stage may reserve. */
export const MAX_LOOP_VERIFICATION_STAGE_RESOURCES = 16;
/** Longest accepted stage command. */
export const MAX_LOOP_VERIFICATION_COMMAND_LENGTH = 8_192;

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const STAGE_FIELDS = [
  "id",
  "command",
  "required",
  "timeoutMs",
  "paths",
  "dependencyPaths",
  "cacheable",
  "dependsOn",
  "parallel",
  "resources",
] as const;

export type LoopVerificationPlanRules = {
  /** Message prefix, so each surface still reports the failure in its own vocabulary. */
  label: string;
  /** Reject stage fields outside {@link STAGE_FIELDS} (authored declarations only). */
  rejectUnknownFields?: boolean;
  /** Upper bound for `timeoutMs`; unbounded (positive safe integer) when omitted. */
  maxTimeoutMs?: number;
  /**
   * The plan was read back from persisted resume state rather than authored
   * now. Value-level rules an older build did not enforce are then repaired
   * instead of rejected — duplicate path prefixes are collapsed and a
   * non-boolean `required`/`cacheable`/`parallel` is dropped, exactly as the
   * builder below already drops it. Rejecting these would strand checkpoints
   * that a previous version happily wrote, which is the same reason
   * `rejectUnknownFields` is off on this path.
   */
  replayed?: boolean;
};

function boundedPathPrefixes(value: unknown, label: string, replayed = false): string[] {
  const unique = isDenseArray(value) ? [...new Set(value)] : [];
  if (
    !isDenseArray(value) ||
    value.length === 0 ||
    value.length > MAX_LOOP_VERIFICATION_STAGE_PATHS ||
    (!replayed && unique.length !== value.length)
  ) {
    throw new Error(`${label} must contain 1 to ${MAX_LOOP_VERIFICATION_STAGE_PATHS} unique prefixes`);
  }
  if (!unique.every(isVerificationPathPrefix)) throw new Error(`${label} contains an invalid relative prefix`);
  return unique as string[];
}

function stageTimeoutMs(raw: unknown, label: string, maxTimeoutMs: number | undefined): number {
  const bounded = maxTimeoutMs === undefined ? Number.MAX_SAFE_INTEGER : maxTimeoutMs;
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > bounded) {
    throw new Error(
      maxTimeoutMs === undefined
        ? `${label} must be a positive safe integer`
        : `${label} must be an integer from 1 to ${maxTimeoutMs}`,
    );
  }
  return raw as number;
}

/**
 * Validates a declared verification pipeline and returns the normalized stages
 * (known fields only, arrays copied). Throws on the first violation; the
 * caller may discard the result and keep its own input when it does not want
 * the normalization.
 */
export function parseLoopVerificationPlan(value: unknown, rules: LoopVerificationPlanRules): LoopVerificationStage[] {
  const { label } = rules;
  if (!isDenseArray(value) || value.length === 0 || value.length > MAX_LOOP_VERIFICATION_STAGES) {
    throw new Error(`${label} must contain 1 to ${MAX_LOOP_VERIFICATION_STAGES} stages`);
  }
  const ids = new Set<string>();
  const stages = value.map((raw): LoopVerificationStage => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !STAGE_ID_RE.test(raw.id) || ids.has(raw.id)) {
      throw new Error(`${label} requires a unique safe stage id`);
    }
    ids.add(raw.id);
    if (rules.rejectUnknownFields) {
      for (const key of Object.keys(raw)) {
        if (!(STAGE_FIELDS as readonly string[]).includes(key)) {
          throw new Error(`${label} stage ${raw.id} declares an unsupported field: ${key}`);
        }
      }
    }
    if (
      typeof raw.command !== "string" ||
      !raw.command.trim() ||
      raw.command.length > MAX_LOOP_VERIFICATION_COMMAND_LENGTH
    ) {
      throw new Error(`${label} stage ${raw.id} requires a bounded command`);
    }
    if (!rules.replayed) {
      for (const key of ["required", "cacheable", "parallel"] as const) {
        if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
          throw new Error(`${label} stage ${raw.id} ${key} must be boolean`);
        }
      }
    }
    const paths =
      raw.paths === undefined
        ? undefined
        : boundedPathPrefixes(raw.paths, `${label} stage ${raw.id} paths`, rules.replayed);
    const dependencyPaths =
      raw.dependencyPaths === undefined
        ? undefined
        : boundedPathPrefixes(raw.dependencyPaths, `${label} stage ${raw.id} dependencyPaths`, rules.replayed);
    if (dependencyPaths?.some((path) => !paths?.includes(path))) {
      throw new Error(`${label} stage ${raw.id} dependencyPaths must be a subset of paths`);
    }
    let dependsOn: string[] | undefined;
    if (raw.dependsOn !== undefined) {
      if (
        !isDenseArray(raw.dependsOn) ||
        raw.dependsOn.length === 0 ||
        raw.dependsOn.length >= MAX_LOOP_VERIFICATION_STAGES ||
        new Set(raw.dependsOn).size !== raw.dependsOn.length ||
        !raw.dependsOn.every((id) => typeof id === "string" && STAGE_ID_RE.test(id))
      ) {
        throw new Error(`${label} stage ${raw.id} dependsOn must contain unique safe stage ids`);
      }
      dependsOn = [...raw.dependsOn] as string[];
    }
    let resources: string[] | undefined;
    if (raw.resources !== undefined) {
      if (
        !isDenseArray(raw.resources) ||
        raw.resources.length === 0 ||
        raw.resources.length > MAX_LOOP_VERIFICATION_STAGE_RESOURCES ||
        new Set(raw.resources).size !== raw.resources.length ||
        !raw.resources.every(isValidOrchestrationResourceId)
      ) {
        throw new Error(`${label} stage ${raw.id} resources must be unique safe names`);
      }
      resources = [...raw.resources] as string[];
    }
    if (raw.parallel === true && !resources?.length) {
      throw new Error(`${label} stage ${raw.id} parallel requires resources`);
    }
    return {
      id: raw.id,
      command: raw.command,
      ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
      ...(raw.timeoutMs === undefined
        ? {}
        : {
            timeoutMs: stageTimeoutMs(raw.timeoutMs, `${label} stage ${raw.id} timeoutMs`, rules.maxTimeoutMs),
          }),
      ...(paths ? { paths } : {}),
      ...(dependencyPaths ? { dependencyPaths } : {}),
      ...(typeof raw.cacheable === "boolean" ? { cacheable: raw.cacheable } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      ...(typeof raw.parallel === "boolean" ? { parallel: raw.parallel } : {}),
      ...(resources ? { resources } : {}),
    };
  });
  for (const stage of stages) {
    if (stage.dependsOn?.some((id) => id === stage.id || !ids.has(id))) {
      throw new Error(`${label} stage ${stage.id} depends on an unknown stage`);
    }
  }
  const remaining = new Map(stages.map((stage) => [stage.id, new Set(stage.dependsOn ?? [])]));
  const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    remaining.delete(id);
    visited++;
    for (const [candidate, dependencies] of remaining) {
      if (dependencies.delete(id) && dependencies.size === 0) ready.push(candidate);
    }
  }
  if (visited !== stages.length) throw new Error(`${label} contains a stage dependency cycle`);
  return stages;
}
