import { describe, expect, it } from "vitest";
import {
  automaticRecoveryEligible,
  nextAutomaticRecoveryMetadata,
  parseAutomaticRecoveryMetadata,
} from "../../src/agent/recovery-policy.js";

describe("automatic recovery policy", () => {
  it("parses the shared exact persisted contract", () => {
    const metadata = {
      attempts: 2,
      lastAttemptAt: "2026-01-01T00:00:00.000Z",
      nextAttemptAt: "2026-01-01T00:01:00.000Z",
      lastError: "offline",
    };
    expect(parseAutomaticRecoveryMetadata(undefined)).toBeUndefined();
    expect(parseAutomaticRecoveryMetadata(metadata)).toEqual(metadata);
    expect(parseAutomaticRecoveryMetadata({ ...metadata, extra: true })).toBeNull();
    expect(
      parseAutomaticRecoveryMetadata({
        ...metadata,
        nextAttemptAt: "2025-12-31T23:59:59.000Z",
      }),
    ).toBeNull();
    expect(parseAutomaticRecoveryMetadata({ ...metadata, attempts: 0 })).toBeNull();
  });

  it("caps exponential delay and error detail", () => {
    const first = nextAutomaticRecoveryMetadata(undefined, new Error("x".repeat(9_000)), new Date(0));
    expect(first).toMatchObject({
      attempts: 1,
      lastAttemptAt: "1970-01-01T00:00:00.000Z",
      nextAttemptAt: "1970-01-01T00:00:30.000Z",
    });
    expect(first.lastError).toHaveLength(8_192);
    const capped = nextAutomaticRecoveryMetadata(
      { attempts: 1_000, lastAttemptAt: first.lastAttemptAt },
      "again",
      new Date(0),
    );
    expect(capped.nextAttemptAt).toBe("1970-01-01T01:00:00.000Z");
    expect(automaticRecoveryEligible(capped, 3_599_999)).toBe(false);
    expect(automaticRecoveryEligible(capped, 3_600_000)).toBe(true);
  });
});
