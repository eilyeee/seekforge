import { describe, expect, it } from "vitest";
import { createSerialQueue, LatestRequest } from "./async-coordination";

describe("LatestRequest", () => {
  it("rejects stale selections and closed details", () => {
    const requests = new LatestRequest();
    const first = requests.begin();
    const second = requests.begin();
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);
    requests.invalidate();
    expect(requests.isCurrent(second)).toBe(false);
  });
});

describe("createSerialQueue", () => {
  it("starts mutations in order and continues after a failure", async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      throw new Error("failed");
    });
    const second = enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("failed");
    await second;
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
