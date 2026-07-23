import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  maybeMaintainProjectMemory,
  memoryMaintenanceStatePath,
  readMemoryMaintenanceState,
  resolveMemoryMaintenanceConfig,
} from "../../src/memory/index.js";
import { makeWorkspace, readProjectMd, writeProjectMemory } from "./helpers.js";

const enabled = {
  enabled: true,
  minFacts: 2,
  minBytes: 4 * 1024 * 1024,
  minIntervalHours: 24,
} as const;

describe("automatic memory maintenance", () => {
  it("is opt-in and waits for either threshold", () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "# Project Memory\n- [tech] one fact\n");

    expect(maybeMaintainProjectMemory(ws, undefined).status).toBe("disabled");
    expect(maybeMaintainProjectMemory(ws, { ...enabled, minFacts: 10 }).status).toBe("below_threshold");
    expect(readMemoryMaintenanceState(ws)).toBeUndefined();
  });

  it("compacts deterministically, records bounded status, and respects the interval", () => {
    const ws = makeWorkspace();
    const duplicated = "# Project Memory\n- [tech] use pnpm workspaces\n- [tech] use pnpm workspaces\n";
    writeProjectMemory(ws, duplicated);
    const now = new Date("2026-07-23T00:00:00.000Z");

    const first = maybeMaintainProjectMemory(ws, enabled, now);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("maintenance did not complete");
    expect(first.result.removed).toHaveLength(1);
    expect(first.state.lastResult).toEqual({ before: 2, after: 1, removed: 1, merged: 0, archived: 0 });
    expect(readMemoryMaintenanceState(ws)).toEqual(first.state);
    expect(readProjectMd(ws).match(/use pnpm workspaces/g)).toHaveLength(1);

    writeProjectMemory(ws, duplicated);
    expect(
      maybeMaintainProjectMemory(ws, { ...enabled, minIntervalHours: 0.333333 }, new Date("2026-07-23T00:01:00.000Z"))
        .status,
    ).toBe("throttled");
    expect(maybeMaintainProjectMemory(ws, enabled, new Date("2026-07-23T01:00:00.000Z")).status).toBe("throttled");
    expect(readProjectMd(ws).match(/use pnpm workspaces/g)).toHaveLength(2);

    expect(maybeMaintainProjectMemory(ws, enabled, new Date("2026-07-24T00:00:00.000Z")).status).toBe("completed");
    expect(readProjectMd(ws).match(/use pnpm workspaces/g)).toHaveLength(1);
  });

  it("can trigger on bytes and archives stale unused facts only when configured", () => {
    const ws = makeWorkspace();
    const fact = "[convention] old unused layout rule";
    writeProjectMemory(ws, `# Project Memory\n- ${fact}\n`);
    fs.writeFileSync(
      join(ws, ".seekforge", "memory", "fact-meta.json"),
      `${JSON.stringify({ [fact]: { addedAt: "2020-01-01T00:00:00.000Z", uses: 0 } })}\n`,
    );

    const outcome = maybeMaintainProjectMemory(
      ws,
      { enabled: true, minFacts: 1_000, minBytes: 1, minIntervalHours: 0, pruneUnusedDays: 90 },
      new Date("2026-07-23T00:00:00.000Z"),
    );
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("maintenance did not complete");
    expect(outcome.result.archived).toEqual([`- ${fact}`]);
    expect(readProjectMd(ws)).not.toContain(fact);
    expect(fs.readFileSync(join(ws, ".seekforge", "memory", "project-archive.md"), "utf8")).toContain(fact);
  });

  it("preserves corrupt maintenance state and leaves the triggering operation fail-open", () => {
    const ws = makeWorkspace();
    const original = "# Project Memory\n- [tech] duplicate\n- [tech] duplicate\n";
    writeProjectMemory(ws, original);
    const statePath = memoryMaintenanceStatePath(ws);
    fs.mkdirSync(dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{"truncated":');

    const outcome = maybeMaintainProjectMemory(ws, enabled);
    expect(outcome.status).toBe("failed");
    expect(readProjectMd(ws)).toBe(original);
    expect(fs.readFileSync(statePath, "utf8")).toBe('{"truncated":');
  });

  it("validates every structured config field and rejects unknown keys", () => {
    expect(resolveMemoryMaintenanceConfig(undefined)).toMatchObject({
      enabled: false,
      minFacts: 100,
      minBytes: 64 * 1024,
      minIntervalHours: 24,
    });
    expect(() => resolveMemoryMaintenanceConfig({ enabled: "yes" })).toThrow(/enabled/);
    expect(() => resolveMemoryMaintenanceConfig({ minFacts: 0 })).toThrow(/minFacts/);
    expect(() => resolveMemoryMaintenanceConfig({ minBytes: Number.POSITIVE_INFINITY })).toThrow(/minBytes/);
    expect(() => resolveMemoryMaintenanceConfig({ minIntervalHours: -1 })).toThrow(/minIntervalHours/);
    expect(() => resolveMemoryMaintenanceConfig({ pruneUnusedDays: -1 })).toThrow(/pruneUnusedDays/);
    expect(() => resolveMemoryMaintenanceConfig({ surprise: true })).toThrow(/unknown/);
    expect(resolveMemoryMaintenanceConfig({ minIntervalHours: 0.333333 })).toMatchObject({
      minIntervalHours: 0.333333,
    });
  });
});
