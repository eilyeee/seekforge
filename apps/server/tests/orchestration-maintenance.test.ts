import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        orchestrationMaintenanceIntervalMs: 2_147_483_648,
      }),
    ).rejects.toThrow(/orchestrationMaintenanceIntervalMs/);
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
