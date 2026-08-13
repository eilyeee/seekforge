import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TIMER_DELAY_MS } from "@seekforge/shared/timers";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/index.js";
import { unusedAgentFactory } from "./helpers.js";

describe("server orchestration maintenance preflight", () => {
  it("rejects dependent and overflowing options before server effects", async () => {
    await expect(
      startServer({ port: 0, workspaces: [process.cwd()], orchestrationAutoRollback: true }),
    ).rejects.toThrow(/requires orchestrationAutoMaintain/);
    await expect(
      startServer({
        port: 0,
        workspaces: [process.cwd()],
        orchestrationAutoMaintain: true,
        orchestrationMaintenanceIntervalMs: MAX_TIMER_DELAY_MS + 1,
      }),
    ).rejects.toThrow(/orchestrationMaintenanceIntervalMs/);
  });

  /**
   * The boundary the preflight above rejects on, from the other side: a delay
   * exactly at the timer ceiling is a legitimate "effectively never" and must
   * start a server rather than be refused. Pairing the two pins the ceiling at
   * one value; only the rejection half would still pass if it moved.
   */
  it("accepts maintenance delays at the timer ceiling", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-server-timer-ceiling-"));
    const server = await startServer({
      port: 0,
      workspaces: [workspace],
      createAgent: unusedAgentFactory,
      orchestrationAutoMaintain: true,
      orchestrationMaintenanceInitialDelayMs: MAX_TIMER_DELAY_MS,
      orchestrationMaintenanceIntervalMs: MAX_TIMER_DELAY_MS,
    });
    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs a bounded maintenance tick over REST", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-server-orchestration-"));
    const server = await startServer({
      port: 0,
      token: "orchestration-token",
      workspaces: [workspace],
      createAgent: unusedAgentFactory,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/orchestration/maintain`, {
        method: "POST",
        headers: { authorization: "Bearer orchestration-token", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        proposals: [],
        rollouts: [],
        index: { version: 1 },
        analytics: { observations: 0 },
      });
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
