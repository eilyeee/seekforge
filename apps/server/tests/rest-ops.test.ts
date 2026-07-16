import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-ops";

let workspace: string;
let server: RunningServer;
let base: string;

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

function writeSession(ws: string, id: string, createdAt: string): void {
  writeFileIn(
    ws,
    `.seekforge/sessions/${id}/session.json`,
    JSON.stringify({ id, task: `task ${id}`, mode: "edit", status: "completed", createdAt, updatedAt: createdAt }),
  );
}

beforeAll(async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  workspace = makeWorkspace();
  writeSession(workspace, "s1", "2026-01-01T00:00:00.000Z");
  writeSession(workspace, "s2", "2026-01-02T00:00:00.000Z");
  writeSession(workspace, "s3", "2026-01-03T00:00:00.000Z");
  writeSession(workspace, "doomed", "2026-01-04T00:00:00.000Z");
  writeFileIn(workspace, ".seekforge/config.json", JSON.stringify({ apiKey: "sk-test123456", model: "deepseek-chat" }));
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("session delete + prune", () => {
  it("DELETE /api/sessions/:id removes an existing session", async () => {
    const res = await authed("/api/sessions/doomed", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).deleted).toBe(true);
    expect(existsSync(join(workspace, ".seekforge/sessions/doomed"))).toBe(false);
  });

  it("DELETE /api/sessions/:id returns 404 for an unknown session", async () => {
    const res = await authed("/api/sessions/nope-not-here", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe("not_found");
  });

  it("POST /api/sessions/prune keepLast removes overflow sessions", async () => {
    const res = await authed("/api/sessions/prune", {
      method: "POST",
      body: JSON.stringify({ keepLast: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // s3 newest is kept; s1 + s2 pruned.
    expect(body.kept).toBe(1);
    expect(body.removed.sort()).toEqual(["s1", "s2"]);
    expect(existsSync(join(workspace, ".seekforge/sessions/s3"))).toBe(true);
    expect(existsSync(join(workspace, ".seekforge/sessions/s1"))).toBe(false);
  });

  it("POST /api/sessions/prune rejects a bad keepLast", async () => {
    const res = await authed("/api/sessions/prune", {
      method: "POST",
      body: JSON.stringify({ keepLast: -3 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("mcp add + delete", () => {
  it("POST /api/mcp adds a server then DELETE removes it", async () => {
    const add = await authed("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "demo", command: "node", args: ["server.js"], trusted: true }),
    });
    expect(add.status).toBe(200);
    expect((await jsonOf(add)).ok).toBe(true);

    const cfgPath = join(workspace, ".seekforge/config.json");
    let cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers.demo.command).toBe("node");
    expect(cfg.mcpServers.demo.args).toEqual(["server.js"]);
    expect(cfg.mcpServers.demo.trusted).toBe(true);
    // Pre-existing keys preserved.
    expect(cfg.apiKey).toBe("sk-test123456");

    // It shows up via GET /api/mcp.
    const list = await jsonOf(authed("/api/mcp"));
    expect(list.find((s: { name: string }) => s.name === "demo")).toBeDefined();

    const del = await authed("/api/mcp/demo", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await jsonOf(del)).ok).toBe(true);
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers?.demo).toBeUndefined();
    expect(cfg.apiKey).toBe("sk-test123456");
  });

  it("DELETE /api/mcp/:name 404s for an unknown server", async () => {
    const res = await authed("/api/mcp/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /api/mcp rejects a server with no transport", async () => {
    const res = await authed("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/mcp rejects non-string env and header values", async () => {
    const env = await authed("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "bad-env", command: "node", env: { TOKEN: 123 } }),
    });
    const headers = await authed("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "bad-headers", url: "https://example.test/mcp", headers: { authorization: null } }),
    });

    expect(env.status).toBe(400);
    expect(headers.status).toBe(400);
    const config = JSON.parse(readFileSync(join(workspace, ".seekforge/config.json"), "utf8"));
    expect(config.mcpServers?.["bad-env"]).toBeUndefined();
    expect(config.mcpServers?.["bad-headers"]).toBeUndefined();
  });

  it("POST /api/mcp treats non-object config JSON as an empty config doc", async () => {
    const cfgPath = join(workspace, ".seekforge/config.json");
    writeFileIn(workspace, ".seekforge/config.json", "null");
    const add = await authed("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "from-null", command: "node" }),
    });
    expect(add.status).toBe(200);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers["from-null"]).toEqual({ command: "node" });

    // Restore the fixture keys used by later tests in this file.
    writeFileIn(
      workspace,
      ".seekforge/config.json",
      JSON.stringify({ apiKey: "sk-test123456", model: "deepseek-chat" }),
    );
  });

  it("POST /api/mcp rejects a symlinked project config without changing its target", async () => {
    const cfgPath = join(workspace, ".seekforge", "config.json");
    const previous = readFileSync(cfgPath, "utf8");
    const outsidePath = join(makeWorkspace(), "config.json");
    const external = '{"mcpServers":{"outside":{"command":"node"}}}\n';
    writeFileSync(outsidePath, external);
    unlinkSync(cfgPath);
    symlinkSync(outsidePath, cfgPath, "file");
    try {
      const res = await authed("/api/mcp", {
        method: "POST",
        body: JSON.stringify({ name: "demo", command: "node" }),
      });
      expect(res.status).toBe(400);
      expect(readFileSync(outsidePath, "utf8")).toBe(external);
    } finally {
      unlinkSync(cfgPath);
      writeFileSync(cfgPath, previous);
    }
  });
});

describe("doctor", () => {
  it("GET /api/doctor returns the diagnostics shape", async () => {
    const res = await authed("/api/doctor");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.apiKeyConfigured).toBe(true);
    expect(body.nodeVersion).toBe(process.version);
    expect(body.git === null || typeof body.git === "string").toBe(true);
    expect(body.runtimeBin).toEqual({ set: false, exists: false });
    expect(typeof body.mcpServerCount).toBe("number");
    expect(body.modelCount).toBeGreaterThanOrEqual(4);
    expect(body.workspace).toBe(workspace);
  });
});
