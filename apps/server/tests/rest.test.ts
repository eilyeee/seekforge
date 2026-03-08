import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-rest";

let workspace: string;
let server: RunningServer;
let base: string;

const candidate = {
  id: "c1",
  content: "uses pnpm workspaces",
  type: "tech",
  confidence: 0.9,
  sourceSessionId: "s1",
  createdAt: "2026-01-02T00:00:00.000Z",
  status: "pending",
};

function seedWorkspace(ws: string): void {
  writeFileIn(
    ws,
    "package.json",
    JSON.stringify({ name: "fixture-project", scripts: { build: "tsc" }, dependencies: { react: "^18.0.0" } }),
  );
  writeFileIn(ws, "tsconfig.json", "{}");

  // Two sessions, s2 newer than s1.
  writeFileIn(
    ws,
    ".seekforge/sessions/s1/session.json",
    JSON.stringify({
      id: "s1",
      task: "first task",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
  );
  writeFileIn(
    ws,
    ".seekforge/sessions/s1/messages.jsonl",
    `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", role: "user", content: "hi" })}\n`,
  );
  writeFileIn(
    ws,
    ".seekforge/sessions/s2/session.json",
    JSON.stringify({
      id: "s2",
      task: "second task",
      mode: "ask",
      status: "completed",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:01:00.000Z",
    }),
  );

  writeFileIn(ws, ".seekforge/memory/project.md", "# Project Memory\n- [tech] existing fact\n");
  writeFileIn(ws, ".seekforge/memory/candidates.jsonl", `${JSON.stringify(candidate)}\n`);

  writeFileIn(
    ws,
    ".seekforge/skills/demo-skill/skill.json",
    JSON.stringify({
      id: "demo-skill",
      name: "Demo skill",
      description: "a project skill fixture",
      tags: ["demo"],
      triggers: ["demo"],
    }),
  );
  writeFileIn(ws, ".seekforge/skills/demo-skill/SKILL.md", "# Demo skill\ndo the demo thing\n");

  writeFileIn(ws, ".seekforge/config.json", JSON.stringify({ apiKey: "sk-test123456", model: "deepseek-chat" }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return await res.json();
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

beforeAll(async () => {
  // Env wins over file config; clear it so the fixture apiKey is observable.
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  workspace = makeWorkspace();
  seedWorkspace(workspace);
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("auth", () => {
  it("returns 401 without a token", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.error.code).toBe("unauthorized");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns 401 with a wrong token", async () => {
    const res = await get("/api/health", { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
  });

  it("accepts ?token= on the initial page load", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe("REST endpoints", () => {
  it("GET /api/health", async () => {
    const res = await authed("/api/health");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.workspace).toBe(workspace);
    expect(typeof body.version).toBe("string");
  });

  it("GET /api/project detects the fixture project", async () => {
    const res = await authed("/api/project");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.path).toBe(workspace);
    expect(body.name).toBe("fixture-project");
    expect(body.detect.languages).toContain("typescript");
    expect(body.detect.frameworks).toContain("react");
    expect(body.detect.scripts.build).toBe("tsc");
  });

  it("GET /api/sessions lists newest first", async () => {
    const res = await authed("/api/sessions");
    const body = await jsonOf(res);
    expect(body.map((m: { id: string }) => m.id)).toEqual(["s2", "s1"]);
  });

  it("GET /api/sessions/:id returns meta and messages", async () => {
    const res = await authed("/api/sessions/s1");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.meta.id).toBe("s1");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("GET /api/sessions/:id is 404 for unknown and traversal-looking ids", async () => {
    expect((await authed("/api/sessions/nope")).status).toBe(404);
    expect((await authed("/api/sessions/..%2F..%2Fetc")).status).toBe(404);
  });

  it("GET /api/skills lists skills without content", async () => {
    const res = await authed("/api/skills");
    const body = await jsonOf(res);
    const demo = body.find((s: { id: string }) => s.id === "demo-skill");
    expect(demo).toBeDefined();
    expect(demo.name).toBe("Demo skill");
    expect(demo).not.toHaveProperty("content");
  });

  it("GET /api/skills/:id returns the full skill, 404 otherwise", async () => {
    const res = await authed("/api/skills/demo-skill");
    const body = await jsonOf(res);
    expect(body.content).toContain("do the demo thing");
    expect((await authed("/api/skills/missing")).status).toBe(404);
  });

  it("GET /api/memory returns project.md and candidates", async () => {
    const res = await authed("/api/memory");
    const body = await jsonOf(res);
    expect(body.projectMd).toContain("existing fact");
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].id).toBe("c1");
  });

  it("POST /api/memory/:id/approve updates the candidate and project.md", async () => {
    const res = await authed("/api/memory/c1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.status).toBe("approved");
    const projectMd = readFileSync(join(workspace, ".seekforge", "memory", "project.md"), "utf8");
    expect(projectMd).toContain("uses pnpm workspaces");
  });

  it("POST /api/memory/:id/reject is 404 for unknown candidates", async () => {
    const res = await authed("/api/memory/missing/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("GET /api/config masks the apiKey", async () => {
    const res = await authed("/api/config");
    const body = await jsonOf(res);
    expect(body.apiKey).toBe("sk-tes****");
    expect(body.model).toBe("deepseek-chat");
  });

  it("PUT /api/config sets allowed keys and rejects unknown ones", async () => {
    const ok = await authed("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "commandAllowlist", value: "pnpm test, pnpm lint" }),
    });
    expect(ok.status).toBe(200);
    const body = await jsonOf(ok);
    expect(body.commandAllowlist).toEqual(["pnpm test", "pnpm lint"]);
    const file = JSON.parse(readFileSync(join(workspace, ".seekforge", "config.json"), "utf8"));
    expect(file.commandAllowlist).toEqual(["pnpm test", "pnpm lint"]);

    const bad = await authed("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "nope", value: "x" }),
    });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error.code).toBe("bad_request");
  });

  it("unknown endpoints return a JSON 404", async () => {
    const res = await authed("/api/definitely-not-real");
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe("not_found");
  });
});

describe("static serving", () => {
  it("serves a plain info page mentioning the token URL when no UI build exists", async () => {
    // The suite-level server may pick up a real apps/desktop/dist build;
    // simulate "no UI build" explicitly with a nonexistent staticDir.
    const bare = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      staticDir: join(workspace, "definitely-no-dist-here"),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/?token=${TOKEN}`);
      const html = await res.text();
      expect(html).toContain("SeekForge");
      expect(html).toContain(`/?token=${TOKEN}`);
    } finally {
      await bare.close();
    }
  });

  it("serves UI files and blocks path traversal when a dist exists", async () => {
    const distParent = makeWorkspace();
    writeFileIn(distParent, "secret.txt", "top secret");
    writeFileIn(distParent, "dist/index.html", "<html>ui-home</html>");
    writeFileIn(distParent, "dist/assets/app.js", "console.log('app')");

    const ui = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      staticDir: join(distParent, "dist"),
    });
    const uiBase = `http://127.0.0.1:${ui.port}`;
    try {
      const home = await fetch(`${uiBase}/?token=${TOKEN}`);
      expect(await home.text()).toContain("ui-home");

      const asset = await fetch(`${uiBase}/assets/app.js?token=${TOKEN}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");

      // SPA fallback for extension-less client routes.
      const route = await fetch(`${uiBase}/sessions/s1?token=${TOKEN}`);
      expect(await route.text()).toContain("ui-home");

      // Encoded traversal must not escape the dist root.
      const sneak = await fetch(`${uiBase}/%2e%2e/secret.txt?token=${TOKEN}`);
      expect(sneak.status).toBe(404);
      expect(await sneak.text()).not.toContain("top secret");
    } finally {
      await ui.close();
    }
  });
});

describe("ephemeral port", () => {
  it("port 0 reports the real port", () => {
    expect(server.port).toBeGreaterThan(0);
  });
});
