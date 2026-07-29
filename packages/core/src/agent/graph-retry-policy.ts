import { createHash } from "node:crypto";

export type GraphRetryPolicy = {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
};

export const DEFAULT_GRAPH_RETRY_POLICY: GraphRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

/** Returns stable jitter so a recovered attempt keeps the same retry deadline. */
export function graphRetryDelayMs(policy: GraphRetryPolicy, retryNumber: number, identity: string): number {
  if (!Number.isSafeInteger(retryNumber) || retryNumber < 1) throw new RangeError("Graph retry number is invalid");
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** Math.min(retryNumber - 1, 16));
  const sample = createHash("sha256").update(identity).update(`:${retryNumber}`).digest().readUInt32BE(0) / 0xffffffff;
  const factor = 1 - policy.jitterRatio + sample * policy.jitterRatio * 2;
  return Math.max(1, Math.min(policy.maxDelayMs, Math.round(base * factor)));
}
