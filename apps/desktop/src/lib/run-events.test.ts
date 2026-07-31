import { describe, expect, it, vi } from "vitest";
import { fetchRunEventTail } from "./run-events";

function event(seq: number) {
  return {
    runId: "run-1",
    seq,
    ts: `2026-07-${String(seq).padStart(2, "0")}T00:00:00.000Z`,
    frame: { type: "progress" },
  };
}

describe("fetchRunEventTail", () => {
  it("follows monotonic pages and retains the actual tail", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ events: [event(1), event(2)], nextAfterSeq: 2, hasMore: true })
      .mockResolvedValueOnce({ events: [event(3), event(4)], nextAfterSeq: 4, hasMore: true })
      .mockResolvedValueOnce({ events: [event(5)], nextAfterSeq: 5, hasMore: false });

    await expect(fetchRunEventTail(fetchPage, 3)).resolves.toEqual([event(3), event(4), event(5)]);
    expect(fetchPage.mock.calls).toEqual([[0], [2], [4]]);
  });

  it("rejects a stalled cursor", async () => {
    await expect(
      fetchRunEventTail(async () => ({ events: [event(1)], nextAfterSeq: 0, hasMore: true })),
    ).rejects.toThrow(/did not advance/);
  });

  it("rejects malformed event pages", async () => {
    await expect(fetchRunEventTail(async () => ({ events: [{ seq: 1 }] }) as never)).rejects.toThrow(/valid events/);
    await expect(
      fetchRunEventTail(async () => ({ events: [event(1)], nextAfterSeq: 1, hasMore: "yes" }) as never),
    ).rejects.toThrow(/continuation flag/);
  });

  it("rejects out-of-order and cross-run events", async () => {
    await expect(
      fetchRunEventTail(async () => ({ events: [event(2), event(1)], nextAfterSeq: 1, hasMore: false }), 20, "run-1"),
    ).rejects.toThrow(/monotonically/);
    await expect(
      fetchRunEventTail(
        async () => ({ events: [{ ...event(1), runId: "other" }], nextAfterSeq: 1, hasMore: false }),
        20,
        "run-1",
      ),
    ).rejects.toThrow(/different run/);
  });
});
