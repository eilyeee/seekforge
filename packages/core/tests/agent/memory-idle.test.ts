import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryMaintenanceScheduler,
  DEFAULT_MEMORY_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_MEMORY_IDLE_INITIAL_DELAY_MS,
} from "../../src/agent/memory-idle.js";
import { acquireSessionLease } from "../../src/agent/session-lease.js";
import { MEMORY_LEASE_ID } from "../../src/memory/lease.js";
import { readMemoryMaintenanceState } from "../../src/memory/index.js";
import { makeWorkspace, readProjectMd, writeProjectMemory } from "../memory/helpers.js";

const workspaces: string[] = [];

function workspace(): string {
  const created = makeWorkspace();
  workspaces.push(created);
  return created;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("idle memory maintenance scheduler", () => {
  it("runs only after the workspace becomes idle and re-reads config", () => {
    const ws = workspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] duplicate\n- [tech] duplicate\n");
    let enabled = false;
    let locallyIdle = true;
    const scheduler = createMemoryMaintenanceScheduler({
      targets: () => [
        {
          workspace: ws,
          getConfig: () => ({
            enabled,
            minFacts: 2,
            minBytes: 4 * 1024 * 1024,
            minIntervalHours: 0,
          }),
          isIdle: () => locallyIdle,
        },
      ],
      schedule: () => "timer",
      cancel: () => {},
    });

    expect(scheduler.checkNow()[0]?.outcome.status).toBe("disabled");
    enabled = true;
    locallyIdle = false;
    expect(scheduler.checkNow()[0]?.outcome.status).toBe("busy");
    expect(readMemoryMaintenanceState(ws)).toBeUndefined();

    locallyIdle = true;
    expect(scheduler.checkNow()[0]?.outcome.status).toBe("completed");
    expect(readProjectMd(ws).match(/duplicate/g)).toHaveLength(1);
    scheduler.dispose();
  });

  it("skips a workspace with an active session and succeeds after release", () => {
    const ws = workspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] duplicate\n- [tech] duplicate\n");
    const running = acquireSessionLease(ws, "running-session");
    const scheduler = createMemoryMaintenanceScheduler({
      targets: () => [
        {
          workspace: ws,
          getConfig: () => ({ enabled: true, minFacts: 2, minBytes: 4 * 1024 * 1024, minIntervalHours: 0 }),
        },
      ],
      schedule: () => "timer",
      cancel: () => {},
    });

    expect(scheduler.checkNow()[0]?.outcome.status).toBe("busy");
    expect(readProjectMd(ws).match(/duplicate/g)).toHaveLength(2);
    running.release();

    const memoryWriter = acquireSessionLease(ws, MEMORY_LEASE_ID);
    expect(scheduler.checkNow()[0]?.outcome.status).toBe("busy");
    memoryWriter.release();

    expect(scheduler.checkNow()[0]?.outcome.status).toBe("completed");
    expect(readProjectMd(ws).match(/duplicate/g)).toHaveLength(1);
    scheduler.dispose();
  });

  it("owns its timer lifecycle and stops checking after dispose", () => {
    const scheduled: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
    const cancel = vi.fn();
    let reentrantResult: unknown;
    let scheduler: ReturnType<typeof createMemoryMaintenanceScheduler>;
    const onResults = vi.fn(() => {
      reentrantResult = scheduler.checkNow();
    });
    scheduler = createMemoryMaintenanceScheduler({
      targets: () => [],
      schedule: (callback, delayMs) => {
        const handle = {};
        scheduled.push({ callback, delayMs, handle });
        return handle;
      },
      cancel,
      onResults,
    });

    expect(scheduled[0]?.delayMs).toBe(DEFAULT_MEMORY_IDLE_INITIAL_DELAY_MS);
    scheduled[0]?.callback();
    expect(onResults).toHaveBeenCalledWith([]);
    expect(reentrantResult).toEqual([]);
    expect(scheduled[1]?.delayMs).toBe(DEFAULT_MEMORY_IDLE_CHECK_INTERVAL_MS);

    scheduler.dispose();
    expect(cancel).toHaveBeenCalledWith(scheduled[1]?.handle);
    expect(scheduler.checkNow()).toEqual([]);
  });

  it("rejects unsafe timer intervals", () => {
    expect(() =>
      createMemoryMaintenanceScheduler({ targets: () => [], intervalMs: 0, schedule: () => "timer" }),
    ).toThrow(/intervalMs/);
    expect(() =>
      createMemoryMaintenanceScheduler({ targets: () => [], initialDelayMs: Number.POSITIVE_INFINITY }),
    ).toThrow(/initialDelayMs/);
  });
});
