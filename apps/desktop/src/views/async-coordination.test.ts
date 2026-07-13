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

  it("rejects an older workspace load after a newer load begins", () => {
    const requests = new LatestRequest();
    const oldWorkspaceLoad = requests.begin();
    const newWorkspaceLoad = requests.begin();

    expect(requests.isCurrent(oldWorkspaceLoad)).toBe(false);
    expect(requests.isCurrent(newWorkspaceLoad)).toBe(true);
  });

  it("invalidates an in-flight save when the workspace changes", () => {
    const requests = new LatestRequest();
    const save = requests.begin();
    requests.begin();

    expect(requests.isCurrent(save)).toBe(false);
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
