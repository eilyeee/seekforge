/**
 * Dependency-free guards for values that cross a package boundary.
 *
 * Both groups below are needed by decoders in this package *and* by the engine
 * in `@seekforge/core`. `packages/shared` cannot depend on `packages/core`, so
 * the implementation lives here and core re-exports it under its established
 * names rather than keeping a second copy.
 */

/** Narrow an unknown to a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Array inputs crossing a runtime boundary must own every indexed entry. */
export function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

/** Named schedulable resource; dot segments form the reservation hierarchy. */
export const ORCHESTRATION_RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidOrchestrationResourceId(value: unknown): value is string {
  return typeof value === "string" && ORCHESTRATION_RESOURCE_ID_RE.test(value);
}
