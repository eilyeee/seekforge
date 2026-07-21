import { existsSync, readFileSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";
import { writeFixtureServer } from "./mcp-fixture.js";
import { MAX_STATIC_FILE_BYTES } from "../src/static.js";

const TOKEN = "test-token-rest";

let workspace: string;
let server: RunningServer;
let base: string;
let mcpFixture: ReturnType<typeof writeFixtureServer>;

const candidate = {
  id: "c1",
  content: "uses pnpm workspaces",
  type: "tech",
  confidence: 0.9,
  sourceSessionId: "s1",
  createdAt: "2026-01-02T00:00:00.000Z",
  status: "pending",
};

function evolutionProposal(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: "s1",
    type: "agent_rule",
    title: `proposal ${id}`,
    problem: "the agent kept forgetting to typecheck",
    evidence: { commands: ["pnpm typecheck"] },
    proposal: { content: `rule from ${id}` },
    risk: "low",
    status,
    createdAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

function seedWorkspace(ws: string, mcpServerPath: string): void {
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
    ".seekforge/sessions/s1/events.jsonl",
    [
      {
        type: "tool.started",
        toolName: "dispatch_team",
        args: { members: [{ id: "review", agentId: "reviewer", task: "review", dependsOn: [] }] },
      },
      { type: "subagent.started", dispatchId: "ag-1", agentId: "reviewer", task: "review", status: "running" },
      {
        type: "subagent.completed",
        dispatchId: "ag-1",
        agentId: "reviewer",
        task: "review",
        status: "done",
        resultSummary: "clean",
      },
      {
        type: "tool.completed",
        toolName: "dispatch_team",
        result: {
          ok: true,
          data: { status: "done", members: [{ id: "review", agentId: "reviewer", status: "done" }] },
        },
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
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

  // A project subagent definition (builtins explorer/reviewer come for free).
  writeFileIn(
    ws,
    ".seekforge/agents/helper-bot/AGENT.md",
    [
      "---",
      "name: Helper Bot",
      "description: a project agent fixture",
      "trigger: helper | fixture",
      "tools: read_file, search_text",
      "mode: ask",
      "---",
      "",
      "# Helper procedure",
      "secret prompt body",
      "",
    ].join("\n"),
  );

  // Evolution proposals, file (chronological) order: ep1, ep2, ep3.
  writeFileIn(
    ws,
    ".seekforge/evolution/proposals.jsonl",
    [
      evolutionProposal("ep1", "pending"),
      evolutionProposal("ep2", "rejected", { reviewedAt: "2026-01-06T00:00:00.000Z" }),
      evolutionProposal("ep3", "pending"),
    ]
      .map((p) => `${JSON.stringify(p)}\n`)
      .join(""),
  );

  // Session s3 has checkpoints to rewind; s1 exists but has none.
  writeFileIn(
    ws,
    ".seekforge/sessions/s3/session.json",
    JSON.stringify({
      id: "s3",
      task: "third task",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-04T00:01:00.000Z",
    }),
  );
  writeFileIn(
    ws,
    ".seekforge/sessions/s3/checkpoints.jsonl",
    [
      { ts: "2026-01-04T00:00:30.000Z", path: "src/rewind-me.txt", before: "original\n" },
      { ts: "2026-01-04T00:00:40.000Z", path: "src/created-by-session.txt", before: null },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(""),
  );
  writeFileIn(ws, "src/rewind-me.txt", "modified by the session\n");
  writeFileIn(ws, "src/created-by-session.txt", "new file from the session\n");

  writeFileIn(
    ws,
    ".seekforge/config.json",
    JSON.stringify({
      apiKey: "sk-test123456",
      model: "deepseek-chat",
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [mcpServerPath],
          env: { SECRET_TOKEN: "hush-value" },
        },
        broken: { command: "/definitely/not/a/real/binary", trusted: true },
      },
    }),
  );
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
  mcpFixture = writeFixtureServer();
  seedWorkspace(workspace, mcpFixture.serverPath);
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  mcpFixture.cleanup();
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

  it("GET /api/models returns the model list with metadata", async () => {
    const res = await authed("/api/models");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(4);

    // deepseek-v4-flash is the default, not deprecated
    const flash = body.find((m: { id: string }) => m.id === "deepseek-v4-flash");
    expect(flash).toBeDefined();
    expect(flash.isDefault).toBe(true);
    expect(flash.deprecated).toBe(false);
    expect(flash.pricing).toHaveProperty("inputCacheMissPer1M");
    expect(flash.pricing).toHaveProperty("inputCacheHitPer1M");
    expect(flash.pricing).toHaveProperty("outputPer1M");

    // deepseek-chat is deprecated, not default
    const chat = body.find((m: { id: string }) => m.id === "deepseek-chat");
    expect(chat).toBeDefined();
    expect(chat.isDefault).toBe(false);
    expect(chat.deprecated).toBe(true);

    // deepseek-reasoner is deprecated, not default
    const reasoner = body.find((m: { id: string }) => m.id === "deepseek-reasoner");
    expect(reasoner).toBeDefined();
    expect(reasoner.isDefault).toBe(false);
    expect(reasoner.deprecated).toBe(true);

    // deepseek-v4-pro is not deprecated, not default
    const pro = body.find((m: { id: string }) => m.id === "deepseek-v4-pro");
    expect(pro).toBeDefined();
    expect(pro.isDefault).toBe(false);
    expect(pro.deprecated).toBe(false);
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
    expect(body.map((m: { id: string }) => m.id)).toEqual(["s3", "s2", "s1"]);
  });

  it("GET /api/sessions/:id returns meta, messages, and orchestration events", async () => {
    const res = await authed("/api/sessions/s1");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.meta.id).toBe("s1");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.events.map((event: { type: string }) => event.type)).toEqual([
      "tool.started",
      "subagent.started",
      "subagent.completed",
      "tool.completed",
    ]);
  });

  it("GET /api/sessions/:id is 404 for unknown and traversal-looking ids", async () => {
    expect((await authed("/api/sessions/nope")).status).toBe(404);
    expect((await authed("/api/sessions/..%2F..%2Fetc")).status).toBe(404);
  });

  it("GET /api/sessions/:id/audit returns rendered markdown and a structured audit", async () => {
    const res = await authed("/api/sessions/s1/audit");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.markdown).toBe("string");
    expect(body.markdown.length).toBeGreaterThan(0);
    expect(body.audit.meta.id).toBe("s1");
    expect(body.audit).toHaveProperty("turns");
    expect(body.audit).toHaveProperty("filesChanged");
    expect(body.audit).toHaveProperty("totals");
  });

  it("GET /api/sessions/:id/audit is 404 for an unknown session", async () => {
    const res = await authed("/api/sessions/nope/audit");
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe("not_found");
  });

  it("POST /api/sessions/:id/fork clones into a new, listable session id", async () => {
    const res = await authed("/api/sessions/s1/fork", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.id).toBe("string");
    expect(body.id).not.toBe("s1");

    // The forked copy is a real, listable session distinct from the source.
    const list = await jsonOf(await authed("/api/sessions"));
    expect(list.map((m: { id: string }) => m.id)).toContain(body.id);

    // The original is untouched (still has its messages).
    const src = await jsonOf(await authed("/api/sessions/s1"));
    expect(src.meta.id).toBe("s1");
  });

  it("POST /api/sessions/:id/fork is 404 for an unknown session", async () => {
    const res = await authed("/api/sessions/nope/fork", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe("not_found");
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

  it("GET /api/memory includes approved facts with lifecycle metadata", async () => {
    const res = await authed("/api/memory");
    const body = await jsonOf(res);
    expect(Array.isArray(body.facts)).toBe(true);
    const existing = body.facts.find((f: { content: string }) => f.content === "existing fact");
    expect(existing).toBeDefined();
    expect(existing.type).toBe("tech");
    expect(existing.index).toBe(1);
    expect(typeof existing.uses).toBe("number");
  });

  it("POST /api/memory/fact adds an approved fact to project.md", async () => {
    const res = await authed("/api/memory/fact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "run pnpm lint before push", type: "command" }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.status).toBe("approved");
    expect(body.type).toBe("command");
    const projectMd = readFileSync(join(workspace, ".seekforge", "memory", "project.md"), "utf8");
    expect(projectMd).toContain("run pnpm lint before push");
  });

  it("POST /api/memory/fact rejects an invalid type", async () => {
    const res = await authed("/api/memory/fact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x", type: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/memory/fact rejects empty content", async () => {
    const res = await authed("/api/memory/fact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/memory/fact removes an approved fact by match", async () => {
    const res = await authed("/api/memory/fact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match: "run pnpm lint before push" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.removed).toContain("run pnpm lint before push");
    const projectMd = readFileSync(join(workspace, ".seekforge", "memory", "project.md"), "utf8");
    expect(projectMd).not.toContain("run pnpm lint before push");
  });

  it("DELETE /api/memory/fact 400s when neither index nor match is given", async () => {
    const res = await authed("/api/memory/fact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/memory/fact 400s for a non-existent index", async () => {
    const res = await authed("/api/memory/fact", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 999 }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/config masks the apiKey", async () => {
    const res = await authed("/api/config");
    const body = await jsonOf(res);
    expect(body.apiKey).toBe("sk-tes****");
    expect(body.model).toBe("deepseek-chat");
    // mcpServers entries may carry secret env values — never exposed here.
    expect(body).not.toHaveProperty("mcpServers");
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

  it("PUT /api/config treats existing non-object config JSON as empty", async () => {
    const configPath = join(workspace, ".seekforge", "config.json");
    const previous = readFileSync(configPath, "utf8");
    try {
      writeFileSync(configPath, "null\n");
      const res = await authed("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "model", value: "deepseek-chat" }),
      });
      expect(res.status).toBe(200);
      const file = JSON.parse(readFileSync(configPath, "utf8"));
      expect(file).toEqual({ model: "deepseek-chat" });
    } finally {
      writeFileSync(configPath, previous);
    }
  });

  it("PUT /api/config rejects a symlinked project config without changing its target", async () => {
    const configPath = join(workspace, ".seekforge", "config.json");
    const previous = readFileSync(configPath, "utf8");
    const outsidePath = join(makeWorkspace(), "config.json");
    const external = '{"model":"outside-model"}\n';
    writeFileSync(outsidePath, external);
    unlinkSync(configPath);
    symlinkSync(outsidePath, configPath, "file");
    try {
      const res = await authed("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "model", value: "deepseek-chat" }),
      });
      expect(res.status).toBe(400);
      expect(readFileSync(outsidePath, "utf8")).toBe(external);
    } finally {
      unlinkSync(configPath);
      writeFileSync(configPath, previous);
    }
  });

  it("unknown endpoints return a JSON 404", async () => {
    const res = await authed("/api/definitely-not-real");
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe("not_found");
  });

  it("GET /api/diff returns the workspace git diff", async () => {
    // the suite workspace is not a git repo by default — make it one
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "T"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
    writeFileIn(workspace, "package.json", JSON.stringify({ name: "fixture-project-CHANGED" }));

    const res = await authed("/api/diff");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.truncated).toBe(false);
    expect(body.diff).toContain("diff --git a/package.json");
    expect(body.diff).toContain("fixture-project-CHANGED");

    const unauth = await fetch(`${base}/api/diff`);
    expect(unauth.status).toBe(401);
  });
});

describe("agents endpoints", () => {
  it("GET /api/agents lists project + builtin agents without prompt bodies", async () => {
    const res = await authed("/api/agents");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);

    const ids = body.map((a: { id: string }) => a.id);
    expect(ids).toContain("helper-bot");
    expect(ids).toContain("explorer");
    expect(ids).toContain("reviewer");

    const helper = body.find((a: { id: string }) => a.id === "helper-bot");
    expect(helper).toMatchObject({
      id: "helper-bot",
      name: "Helper Bot",
      description: "a project agent fixture",
      scope: "project",
      mode: "ask",
      tools: ["read_file", "search_text"],
      triggers: ["helper", "fixture"],
    });

    for (const agent of body) expect(agent).not.toHaveProperty("body");
  });

  it("GET /api/agents/:id returns the full definition incl. body, 404 otherwise", async () => {
    const res = await authed("/api/agents/helper-bot");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.id).toBe("helper-bot");
    expect(body.body).toContain("secret prompt body");

    expect((await authed("/api/agents/no-such-agent")).status).toBe(404);
  });
});

describe("evolution endpoints", () => {
  it("GET /api/evolution lists proposals pending-first, newest-first within groups", async () => {
    const res = await authed("/api/evolution");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.map((p: { id: string }) => p.id)).toEqual(["ep3", "ep1", "ep2"]);
    expect(body.map((p: { status: string }) => p.status)).toEqual(["pending", "pending", "rejected"]);
  });

  it("POST apply on a pending proposal is a 409 conflict", async () => {
    const res = await authed("/api/evolution/ep3/apply", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("must be accepted before apply");
  });

  it("POST accept then apply returns the applied proposal and the changed path", async () => {
    const accepted = await authed("/api/evolution/ep3/accept", { method: "POST" });
    expect(accepted.status).toBe(200);
    const acceptedBody = await jsonOf(accepted);
    expect(acceptedBody.id).toBe("ep3");
    expect(acceptedBody.status).toBe("accepted");
    expect(typeof acceptedBody.reviewedAt).toBe("string");

    const applied = await authed("/api/evolution/ep3/apply", { method: "POST" });
    expect(applied.status).toBe(200);
    const appliedBody = await jsonOf(applied);
    expect(appliedBody.proposal.status).toBe("applied");
    expect(appliedBody.changedPath).toBe(join(workspace, "AGENTS.md"));
    expect(readFileSync(appliedBody.changedPath, "utf8")).toContain("- rule from ep3");
  });

  it("POST reject updates the proposal; re-reviewing it is a 409", async () => {
    const rejected = await authed("/api/evolution/ep1/reject", { method: "POST" });
    expect(rejected.status).toBe(200);
    expect((await jsonOf(rejected)).status).toBe("rejected");

    const again = await authed("/api/evolution/ep1/accept", { method: "POST" });
    expect(again.status).toBe(409);
    expect((await jsonOf(again)).error.message).toContain("is not pending");
  });

  it("unknown proposal ids are 404", async () => {
    expect((await authed("/api/evolution/nope/accept", { method: "POST" })).status).toBe(404);
    expect((await authed("/api/evolution/nope/apply", { method: "POST" })).status).toBe(404);
  });
});

describe("mcp endpoints", () => {
  it("GET /api/mcp lists configured servers without spawning or leaking env values", async () => {
    const res = await authed("/api/mcp");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("hush-value"); // env VALUES must never leave the server
    const body = JSON.parse(text);

    const fake = body.find((s: { name: string }) => s.name === "fake");
    expect(fake).toEqual({
      name: "fake",
      transport: "stdio",
      command: process.execPath,
      args: [mcpFixture.serverPath],
      env: { SECRET_TOKEN: "********" },
      headers: {},
      trusted: false,
      source: "project",
      shadowedGlobal: false,
    });

    const broken = body.find((s: { name: string }) => s.name === "broken");
    expect(broken).toMatchObject({ name: "broken", transport: "stdio", trusted: true, env: {}, source: "project" });
  });

  it("POST /api/mcp/:name/test reports per-server connection status", async () => {
    const res = await authed("/api/mcp/fake/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, toolCount: 2 });
  });

  it("POST /api/mcp/:name/tools spawns, lists tools, and disposes", async () => {
    const res = await authed("/api/mcp/fake/tools", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tools).toEqual([
      { name: "echo", description: "Echoes arguments back." },
      {
        name: "boom",
        description: JSON.stringify({ roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }] }),
      },
    ]);
  });

  it("POST /api/mcp/:name/tools is 404 for unconfigured servers", async () => {
    const res = await authed("/api/mcp/missing/tools", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/mcp/:name/tools is 502 mcp_error when the server cannot launch", async () => {
    const res = await authed("/api/mcp/broken/tools", { method: "POST" });
    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body.error.code).toBe("mcp_error");
    expect(typeof body.error.message).toBe("string");
  });
});

describe("rewind endpoint", () => {
  function rewind(payload: unknown): Promise<Response> {
    return authed("/api/rewind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("dry-run reports the plan without touching files", async () => {
    const res = await rewind({ sessionId: "s3", dryRun: true });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toEqual({
      restored: ["src/rewind-me.txt"],
      deleted: ["src/created-by-session.txt"],
      skipped: [],
    });
    expect(readFileSync(join(workspace, "src/rewind-me.txt"), "utf8")).toBe("modified by the session\n");
    expect(existsSync(join(workspace, "src/created-by-session.txt"))).toBe(true);
  });

  it("a real rewind restores pre-session content and deletes created files", async () => {
    const res = await rewind({ sessionId: "s3" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.restored).toEqual(["src/rewind-me.txt"]);
    expect(body.deleted).toEqual(["src/created-by-session.txt"]);
    expect(readFileSync(join(workspace, "src/rewind-me.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(workspace, "src/created-by-session.txt"))).toBe(false);
  });

  it("is 404 for unknown / traversal session ids and sessions without checkpoints", async () => {
    expect((await rewind({ sessionId: "nope" })).status).toBe(404);
    expect((await rewind({ sessionId: "../../etc" })).status).toBe(404);
    const noCheckpoints = await rewind({ sessionId: "s1" });
    expect(noCheckpoints.status).toBe(404);
    expect((await jsonOf(noCheckpoints)).error.message).toContain("no checkpoints");
  });

  it("is 400 for malformed bodies", async () => {
    expect((await rewind({})).status).toBe(400);
    const res = await authed("/api/rewind", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
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
      const res = await fetch(`http://127.0.0.1:${bare.port}/`);
      const html = await res.text();
      expect(html).toContain("SeekForge");
      // The info page is public now — it must NOT leak the token.
      expect(html).not.toContain(TOKEN);
    } finally {
      await bare.close();
    }
  });

  it("serves static assets without a token while /api stays protected", async () => {
    const distParent = makeWorkspace();
    writeFileIn(distParent, "dist/index.html", "<html>ui-home</html>");
    writeFileIn(distParent, "dist/assets/app.js", "console.log('ui')");
    const ui = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      staticDir: join(distParent, "dist"),
    });
    try {
      const baseUi = `http://127.0.0.1:${ui.port}`;
      // index.html's subresources can't carry the token — they must be public.
      const asset = await fetch(`${baseUi}/assets/app.js`);
      expect(asset.status).toBe(200);
      const index = await fetch(`${baseUi}/`);
      expect(index.status).toBe(200);
      // Capability stays gated: the API still rejects tokenless requests.
      const api = await fetch(`${baseUi}/api/health`);
      expect(api.status).toBe(401);
    } finally {
      await ui.close();
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
      const assetHead = await fetch(`${uiBase}/assets/app.js?token=${TOKEN}`, { method: "HEAD" });
      expect(assetHead.status).toBe(200);
      expect(assetHead.headers.get("content-length")).toBe(String(Buffer.byteLength("console.log('app')")));
      expect(await assetHead.text()).toBe("");

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

  it("does not serve files through symlinks inside the static root", async () => {
    const distParent = makeWorkspace();
    const outside = makeWorkspace();
    writeFileIn(distParent, "dist/index.html", "<html>ui-home</html>");
    writeFileIn(outside, "secret.txt", "outside secret");
    symlinkSync(join(outside, "secret.txt"), join(distParent, "dist/secret.txt"), "file");
    symlinkSync(outside, join(distParent, "dist/linked-assets"), "dir");

    const ui = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      staticDir: join(distParent, "dist"),
    });
    const uiBase = `http://127.0.0.1:${ui.port}`;
    try {
      for (const path of ["/secret.txt", "/linked-assets/secret.txt"]) {
        const res = await fetch(`${uiBase}${path}`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("outside secret");
      }
    } finally {
      await ui.close();
    }
  });

  it("rejects oversized public static assets without buffering them", async () => {
    const distParent = makeWorkspace();
    writeFileIn(distParent, "dist/index.html", "<html>ui-home</html>");
    const large = join(distParent, "dist/assets/large.js");
    writeFileIn(distParent, "dist/assets/large.js", "");
    truncateSync(large, MAX_STATIC_FILE_BYTES + 1);
    const ui = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      staticDir: join(distParent, "dist"),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ui.port}/assets/large.js`);
      expect(response.status).toBe(404);
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
