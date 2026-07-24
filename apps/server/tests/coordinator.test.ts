import { join } from "node:path";
import { realpathSync } from "node:fs";
import { acquireLoopLease, acquireSessionLease } from "@seekforge/core";
import { describe, expect, it, vi } from "vitest";
import { canonicalRepositoryKey, ServerCoordinator } from "../src/coordinator.js";
import { makeWorkspace } from "./helpers.js";

describe("canonicalRepositoryKey", () => {
  it("uses a physical workspace key for an existing non-Git directory", async () => {
    const workspace = makeWorkspace();
    await expect(canonicalRepositoryKey(workspace)).resolves.toBe(`workspace:${realpathSync(workspace)}`);
  });

  it("surfaces Git spawn failures instead of weakening repository serialization", async () => {
    const missing = join(makeWorkspace(), "missing-workspace");
    await expect(canonicalRepositoryKey(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ServerCoordinator idle mutation", () => {
  it("skips queued repository work without waiting and succeeds after it drains", async () => {
    const workspace = makeWorkspace();
    const coordinator = new ServerCoordinator();
    let release = (): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const foreground = coordinator.withRepository(workspace, async () => {
      markStarted();
      await gate;
    });
    await started;

    const operation = vi.fn(async () => "recovered");
    await expect(coordinator.tryWithIdleAgentMutation(workspace, undefined, operation)).resolves.toEqual({
      acquired: false,
    });
    expect(operation).not.toHaveBeenCalled();

    release();
    await foreground;
    await expect(coordinator.tryWithIdleAgentMutation(workspace, undefined, operation)).resolves.toEqual({
      acquired: true,
      value: "recovered",
    });
    await coordinator.drain();
  });

  it("skips a workspace with another process-visible session", async () => {
    const workspace = makeWorkspace();
    const coordinator = new ServerCoordinator();
    const active = acquireSessionLease(workspace, "foreground-session");
    const operation = vi.fn(async () => "unexpected");
    try {
      await expect(coordinator.tryWithIdleAgentMutation(workspace, undefined, operation)).resolves.toEqual({
        acquired: false,
      });
      expect(operation).not.toHaveBeenCalled();
    } finally {
      active.release();
      await coordinator.drain();
    }
  });

  it("skips a workspace with a live Loop between its Agent sessions", async () => {
    const workspace = makeWorkspace();
    const coordinator = new ServerCoordinator();
    const active = acquireLoopLease(workspace, "foreground-loop", true);
    const operation = vi.fn(async () => "unexpected");
    try {
      await expect(coordinator.tryWithIdleAgentMutation(workspace, undefined, operation)).resolves.toEqual({
        acquired: false,
      });
      expect(operation).not.toHaveBeenCalled();
    } finally {
      active.release();
      await coordinator.drain();
    }
  });
});
