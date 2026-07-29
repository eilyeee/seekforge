import { isRecord } from "../util/guards.js";

export type AutomaticRecoveryMetadata = {
  attempts: number;
  lastAttemptAt: string;
  nextAttemptAt?: string;
  lastError?: string;
};

const INITIAL_RECOVERY_DELAY_MS = 30_000;
const MAX_RECOVERY_DELAY_MS = 60 * 60_000;
const MAX_RECOVERY_ERROR_LENGTH = 8_192;

export function automaticRecoveryTime(now: Date): { nowMs: number; nowIso: string } {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Automatic recovery time must be valid");
  return { nowMs, nowIso: now.toISOString() };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Decodes the single persisted recovery metadata contract shared by Loop and Graph. */
export function parseAutomaticRecoveryMetadata(value: unknown): AutomaticRecoveryMetadata | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => key !== "attempts" && key !== "lastAttemptAt" && key !== "nextAttemptAt" && key !== "lastError",
    ) ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 1 ||
    !validTimestamp(value.lastAttemptAt) ||
    (value.nextAttemptAt !== undefined && !validTimestamp(value.nextAttemptAt)) ||
    (value.nextAttemptAt !== undefined &&
      Date.parse(value.nextAttemptAt as string) < Date.parse(value.lastAttemptAt as string)) ||
    (value.lastError !== undefined &&
      (typeof value.lastError !== "string" ||
        value.lastError.length < 1 ||
        value.lastError.length > MAX_RECOVERY_ERROR_LENGTH))
  ) {
    return null;
  }
  return {
    attempts: value.attempts as number,
    lastAttemptAt: value.lastAttemptAt as string,
    ...(typeof value.nextAttemptAt === "string" ? { nextAttemptAt: value.nextAttemptAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

export function automaticRecoveryEligible(recovery: AutomaticRecoveryMetadata | undefined, nowMs: number): boolean {
  return recovery?.nextAttemptAt === undefined || Date.parse(recovery.nextAttemptAt) <= nowMs;
}

export function nextAutomaticRecoveryMetadata(
  previous: AutomaticRecoveryMetadata | undefined,
  error: unknown,
  now: Date,
): AutomaticRecoveryMetadata {
  const { nowMs, nowIso } = automaticRecoveryTime(now);
  const attempts = Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1);
  const delayMs = Math.min(MAX_RECOVERY_DELAY_MS, INITIAL_RECOVERY_DELAY_MS * 2 ** Math.min(attempts - 1, 7));
  const lastError =
    (error instanceof Error ? error.message : String(error)).trim().slice(0, MAX_RECOVERY_ERROR_LENGTH) ||
    "recovery failed";
  return {
    attempts,
    lastAttemptAt: nowIso,
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
