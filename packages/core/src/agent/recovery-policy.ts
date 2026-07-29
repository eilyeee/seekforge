export type AutomaticRecoveryMetadata = {
  attempts: number;
  lastAttemptAt: string;
  nextAttemptAt?: string;
  lastError?: string;
};

const INITIAL_RECOVERY_DELAY_MS = 30_000;
const MAX_RECOVERY_DELAY_MS = 60 * 60_000;

export function automaticRecoveryEligible(recovery: AutomaticRecoveryMetadata | undefined, nowMs: number): boolean {
  return recovery?.nextAttemptAt === undefined || Date.parse(recovery.nextAttemptAt) <= nowMs;
}

export function nextAutomaticRecoveryMetadata(
  previous: AutomaticRecoveryMetadata | undefined,
  error: unknown,
  now: Date,
): AutomaticRecoveryMetadata {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Automatic recovery time must be valid");
  const attempts = Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1);
  const delayMs = Math.min(MAX_RECOVERY_DELAY_MS, INITIAL_RECOVERY_DELAY_MS * 2 ** Math.min(attempts - 1, 7));
  const lastError =
    (error instanceof Error ? error.message : String(error)).trim().slice(0, 8_192) || "recovery failed";
  return {
    attempts,
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    lastError,
  };
}

export function compareAutomaticRecoveryCandidates(
  left: { priority?: number; updatedAt: string },
  right: { priority?: number; updatedAt: string },
): number {
  return (right.priority ?? 0) - (left.priority ?? 0) || Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}
