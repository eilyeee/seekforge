import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-memory";

let workspace: string;
let server: RunningServer;
let base: string;
let savedHome: string | undefined;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

// Response.json() is typed `unknown` in this project; mirror rest.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(r: Response | Promise<Response>): Promise<any> {
  return (await r).json();
}

beforeAll(async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  workspace = makeWorkspace();
  savedHome = process.env["SEEKFORGE_HOME"];
  process.env["SEEKFORGE_HOME"] = makeWorkspace();
  // project.md with an exact-duplicate bullet so compaction has work to do.
  writeFileIn(
    workspace,
    ".seekforge/memory/project.md",
    "# Project Memory\n- [tech] uses pnpm workspaces\n- [tech] uses pnpm workspaces\n- [tech] runs vitest\n",
  );
  writeFileIn(
    workspace,
    ".seekforge/memory/candidates.jsonl",
    [
      {
        id: "c1",
        content: "uses pnpm workspaces",
        type: "tech",
        confidence: 0.9,
        sourceSessionId: "s1",
        createdAt: "2026-01-02T00:00:00.000Z",
        status: "approved",
      },
      {
        id: "c2",
        content: "rejected fact",
        type: "tech",
        confidence: 0.4,
        sourceSessionId: "s1",
        createdAt: "2026-01-02T00:00:00.000Z",
        status: "rejected",
      },
    ]
      .map((c) => `${JSON.stringify(c)}\n`)
      .join(""),
  );
  server = await startServer({
    workspace,
    port: 0,
    token: TOKEN,
    createAgent: unusedAgentFactory,
    memoryMaintenanceInitialDelayMs: 20,
    memoryMaintenanceIntervalMs: 50,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (savedHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = savedHome;
});

describe("memory stats + compact", () => {
  it("GET /api/memory/stats returns the MemoryStats shape", async () => {
    const res = await authed("/api/memory/stats");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.totalApprovedFacts).toBe(3);
    expect(body.approved).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.rejectionRate).toBeCloseTo(0.5, 5);
    expect(body).toHaveProperty("usedFraction");
    expect(body).toHaveProperty("avgConfidenceUsed");
    expect(body).toHaveProperty("avgConfidenceUnused");
    expect(body).toHaveProperty("autoExtractedFacts");
    expect(body).toHaveProperty("directAddedFacts");
    expect(body).toHaveProperty("pending");
  });

  it("POST /api/memory/compact dryRun reports the plan without writing", async () => {
    const res = await authed("/api/memory/compact", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.before).toBe(3);
    expect(body.after).toBe(2);
    expect(body.removed).toContain("- [tech] uses pnpm workspaces");
    expect(Array.isArray(body.merged)).toBe(true);
    expect(Array.isArray(body.archived)).toBe(true);

    // dryRun must NOT have changed project.md (stats still see 3 facts).
    const stats = await jsonOf(authed("/api/memory/stats"));
    expect(stats.totalApprovedFacts).toBe(3);
  });

  it("POST /api/memory/compact rejects a bad pruneUnusedDays", async () => {
    const res = await authed("/api/memory/compact", {
      method: "POST",
      body: JSON.stringify({ pruneUnusedDays: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("config set new keys", () => {
  it("PUT /api/config sets escalateOnFailure from a string boolean", async () => {
    const res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "escalateOnFailure", value: "true", global: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.escalateOnFailure).toBe(true);
  });

  it("PUT /api/config sets memoryAutoApproveConfidence in range", async () => {
    const res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "memoryAutoApproveConfidence", value: 0.75, global: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.memoryAutoApproveConfidence).toBe(0.75);
  });

  it("PUT /api/config accepts a numeric string for memoryAutoApproveConfidence", async () => {
    const res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "memoryAutoApproveConfidence", value: "0.2", global: true }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).memoryAutoApproveConfidence).toBe(0.2);
  });

  it("PUT /api/config rejects memoryAutoApproveConfidence out of 0..1", async () => {
    const res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "memoryAutoApproveConfidence", value: 1.5, global: true }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.code).toBe("bad_request");
  });

  it("validates trusted automatic memory maintenance and runs it while idle", async () => {
    let res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        key: "memoryMaintenance",
        global: true,
        value: { enabled: true, minFacts: 1, minBytes: 4 * 1024 * 1024, minIntervalHours: 0 },
      }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).memoryMaintenance).toMatchObject({ enabled: true, minFacts: 1, minIntervalHours: 0 });

    res = await authed("/api/memory/fact", {
      method: "POST",
      body: JSON.stringify({ content: "automatic maintenance trigger", type: "tech" }),
    });
    expect(res.status).toBe(201);
    let memory: Awaited<ReturnType<typeof jsonOf>> | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      memory = await jsonOf(authed("/api/memory"));
      if (memory.maintenance) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(memory.maintenance).toMatchObject({ version: 1, lastResult: { before: expect.any(Number) } });

    res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "memoryMaintenance", global: true, value: { enabled: true, minFacts: 0 } }),
    });
    expect(res.status).toBe(400);

    res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "memoryMaintenance", global: true, value: { enabled: false } }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT /api/config sets planModel and clears it when empty", async () => {
    let res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "planModel", value: "deepseek-v4-pro" }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).planModel).toBe("deepseek-v4-pro");

    res = await authed("/api/config", {
      method: "PUT",
      body: JSON.stringify({ key: "planModel", value: "" }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).planModel).toBeUndefined();
  });
});
