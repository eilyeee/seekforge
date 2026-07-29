export const ORCHESTRATION_RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type OrchestrationScheduleCandidate = {
  id: string;
  priority?: number;
  resources?: readonly string[];
  score?: number;
};

export type OrchestrationRunningReservation = {
  resources?: readonly string[];
};

export function isValidOrchestrationResourceId(value: unknown): value is string {
  return typeof value === "string" && ORCHESTRATION_RESOURCE_ID_RE.test(value);
}

/** Dot-separated resources form a hierarchy: `provider.deepseek` conflicts with `provider.deepseek.chat`. */
export function orchestrationResourcesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function canReserve(
  resources: readonly string[],
  reservations: readonly string[],
  capacities: Readonly<Record<string, number>>,
): boolean {
  for (const resource of resources) {
    const exactCount = reservations.filter((reserved) => reserved === resource).length;
    const capacity = capacities[resource] ?? 1;
    if (exactCount >= capacity) return false;
    // A capacity only relaxes sharing of the exact resource. Parent/child
    // overlap stays exclusive because the narrower operation may mutate a
    // subset that the broader reservation assumes it owns.
    if (reservations.some((reserved) => reserved !== resource && orchestrationResourcesOverlap(resource, reserved))) {
      return false;
    }
  }
  return true;
}

/**
 * Shared deterministic ready-queue selection for Loop verification, Loop DAG,
 * and Engineering Graph schedulers. Callers remain responsible for dependency
 * and policy eligibility; this owner only ranks and reserves finite resources.
 */
export function selectOrchestrationReadyNodes(
  candidates: readonly OrchestrationScheduleCandidate[],
  running: readonly OrchestrationRunningReservation[],
  availableSlots: number,
  capacities: Readonly<Record<string, number>> = {},
): string[] {
  if (!Number.isSafeInteger(availableSlots) || availableSlots < 0) {
    throw new RangeError("Orchestration availableSlots must be a non-negative safe integer");
  }
  const reservations = running.flatMap((entry) => [...(entry.resources ?? [])]);
  const selected: string[] = [];
  const ranked = [...candidates].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.id.localeCompare(right.id),
  );
  for (const candidate of ranked) {
    if (selected.length >= availableSlots) break;
    const resources = candidate.resources ?? [];
    if (!canReserve(resources, reservations, capacities)) continue;
    selected.push(candidate.id);
    reservations.push(...resources);
  }
  return selected;
}
