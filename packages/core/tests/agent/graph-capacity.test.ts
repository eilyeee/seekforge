import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWorkspaceGraphExecutorCapacity,
  listWorkspaceGraphExecutorReservations,
} from "../../src/agent/graph-capacity.js";

describe("workspace Graph executor capacity", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-graph-capacity-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("enforces capacity, returns an idempotent fencing token, and releases once", () => {
    const root = workspace();
    const first = acquireWorkspaceGraphExecutorCapacity(root, "remote", "graph:node:1", 1)!;
    const duplicate = acquireWorkspaceGraphExecutorCapacity(root, "remote", "graph:node:1", 1)!;
    expect(duplicate.fencingToken).toBe(first.fencingToken);
    expect(acquireWorkspaceGraphExecutorCapacity(root, "remote", "graph:node:2", 1)).toBeUndefined();
    duplicate.release();
    expect(listWorkspaceGraphExecutorReservations(root)).toEqual([]);
    first.release();
  });

  it("expires stale reservations before capacity evaluation", () => {
    const root = workspace();
    const now = new Date("2026-01-01T00:00:00.000Z");
    acquireWorkspaceGraphExecutorCapacity(root, "remote", "old", 1, { ttlMs: 1_000, now });
    const replacement = acquireWorkspaceGraphExecutorCapacity(root, "remote", "new", 1, {
      now: new Date(now.getTime() + 1_001),
    });
    expect(replacement?.reservationId).toBe("new");
    replacement?.release();
  });

  it("rejects a workspace capacity larger than the bounded reservation store", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-graph-capacity-bound-"));
    try {
      expect(() => acquireWorkspaceGraphExecutorCapacity(root, "worker", "too-large", 513)).toThrow(/1 to 512/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
