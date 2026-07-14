import { describe, expect, it } from "vitest";
import { createSerialQueue, LatestRequest, WorkspaceAsyncCoordinator } from "./async-coordination";

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

describe("WorkspaceAsyncCoordinator", () => {
  it("rejects an old workspace response after the active workspace changes", () => {
    let activeWorkspace = "workspace-a";
    const coordinator = new WorkspaceAsyncCoordinator("workspace-a", () => activeWorkspace);
    const load = coordinator.beginLatest();
    expect(load).not.toBeNull();

    activeWorkspace = "workspace-b";

    expect(coordinator.isCurrent(load!)).toBe(false);
    expect(coordinator.beginLatest("workspace-a")).toBeNull();
  });

  it("invalidates captured mutations when the bound workspace changes", () => {
    let activeWorkspace = "workspace-a";
    const coordinator = new WorkspaceAsyncCoordinator("workspace-a", () => activeWorkspace);
    const mutation = coordinator.capture();
    expect(mutation).not.toBeNull();

    activeWorkspace = "workspace-b";
    coordinator.setWorkspace("workspace-b");

    expect(coordinator.isCurrent(mutation!)).toBe(false);
    expect(coordinator.capture()).not.toBeNull();
  });

  it("keeps mutations current across newer requests in the same workspace", () => {
    const coordinator = new WorkspaceAsyncCoordinator("workspace-a", () => "workspace-a");
    const mutation = coordinator.capture();
    const firstLoad = coordinator.beginLatest();
    const secondLoad = coordinator.beginLatest();

    expect(coordinator.isCurrent(mutation!)).toBe(true);
    expect(coordinator.isCurrent(firstLoad!)).toBe(false);
    expect(coordinator.isCurrent(secondLoad!)).toBe(true);
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
