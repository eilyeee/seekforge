/**
 * Tests for the capability endpoints: session turns + backtrack, todos,
 * balance, MCP resources and the extended /api/config fields.
 *
 * HOME is pointed at a throwaway directory so the developer's real
 * ~/.seekforge/config.json can never bleed into these assertions
 * (loadConfig merges the global file).
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";
import { writeFixtureServer } from "./mcp-fixture.js";

const TOKEN = "test-token-cap";

let workspace: string;
let server: RunningServer;
let base: string;
let mcpFixture: ReturnType<typeof writeFixtureServer>;
let savedHome: string | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return await res.json();
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return authed(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedSession(ws: string, id: string): void {
  writeFileIn(
    ws,
    `.seekforge/sessions/${id}/session.json`,
    JSON.stringify({
      id,
      task: "build the feature",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
  );
}

/** 3 user turns interleaved with assistant replies (6 messages total). */
function seedMessages(ws: string, id: string): void {
  const messages = [
    { role: "user", content: "build the feature" },
    { role: "assistant", content: "built it" },
    { role: "user", content: "now add tests" },
    { role: "assistant", content: "added them" },
    { role: "user", content: "polish the docs" },
    { role: "assistant", content: "polished" },
  ];
  writeFileIn(
    ws,
    `.seekforge/sessions/${id}/messages.jsonl`,
    messages.map((m) => `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...m })}\n`).join(""),
  );
}

const TODOS_SEED = "# Project todos\n\nKeep shipping. This prose line must survive.\n- [ ] first\n- [x] second\n";

beforeAll(async () => {
  // Hermetic config: no env key, no developer-global ~/.seekforge.
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  savedHome = process.env["HOME"];
  process.env["HOME"] = makeWorkspace();

  workspace = makeWorkspace();
  mcpFixture = writeFixtureServer();

  for (const id of ["bt1", "bt2", "no-messages"]) seedSession(workspace, id);
  seedMessages(workspace, "bt1");
  seedMessages(workspace, "bt2");

  // Per-turn checkpoints for bt2: a.txt touched at turn 0, b.txt modified at
  // turn 1, c.txt created at turn 2.
  writeFileIn(
    workspace,
    ".seekforge/sessions/bt2/checkpoints.jsonl",
    [
      { ts: "t", path: "src/a.txt", before: "a0\n", turn: 0 },
      { ts: "t", path: "src/b.txt", before: "b0\n", turn: 1 },
      { ts: "t", path: "src/c.txt", before: null, turn: 2 },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(""),
  );
  writeFileIn(workspace, "src/a.txt", "a2\n");
  writeFileIn(workspace, "src/b.txt", "b2\n");
  writeFileIn(workspace, "src/c.txt", "c2\n");

  writeFileIn(workspace, ".seekforge/todos.md", TODOS_SEED);

  // No apiKey on purpose (balance null path); engine knobs set for /api/config.
  writeFileIn(
    workspace,
    ".seekforge/config.json",
    JSON.stringify({
      model: "deepseek-v4-flash",
      sandbox: "workspace-write",
      thinking: true,
      reasoningEffort: "max",
      mcpServers: {
        fake: { command: process.execPath, args: [mcpFixture.serverPath] },
        broken: { command: "/definitely/not/a/real/binary" },
      },
    }),
  );

  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  mcpFixture.cleanup();
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
});

describe("GET /api/sessions/:id/turns", () => {
  it("indexes ALL user messages 0..N-1 and flags turn 0 not backtrackable", async () => {
    const res = await authed("/api/sessions/bt1/turns");
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual([
      { turn: 0, text: "build the feature", backtrackable: false },
      { turn: 1, text: "now add tests", backtrackable: true },
      { turn: 2, text: "polish the docs", backtrackable: true },
    ]);
  });

  it("returns [] for a session without messages.jsonl", async () => {
    const res = await authed("/api/sessions/no-messages/turns");
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual([]);
  });

  it("is 404 for unknown and traversal-looking ids", async () => {
    expect((await authed("/api/sessions/nope/turns")).status).toBe(404);
    expect((await authed("/api/sessions/..%2F..%2Fetc/turns")).status).toBe(404);
  });
});

describe("POST /api/sessions/:id/backtrack", () => {
  it("rejects turn 0, out-of-range and non-integer turns with 400", async () => {
    for (const turn of [0, -1, 99, 1.5, "1"]) {
      const res = await post("/api/sessions/bt1/backtrack", { turn });
      expect(res.status).toBe(400);
    }
    // Nothing was truncated by the rejected attempts.
    expect((await jsonOf(await authed("/api/sessions/bt1/turns"))).length).toBe(3);
  });

  it("is 404 for an unknown session", async () => {
    expect((await post("/api/sessions/nope/backtrack", { turn: 1 })).status).toBe(404);
  });

  it("truncates the conversation without touching files when files is false", async () => {
    const res = await post("/api/sessions/bt1/backtrack", { turn: 2, files: false });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ removedMessages: 2, keptMessages: 4, files: null });

    const turns = await jsonOf(await authed("/api/sessions/bt1/turns"));
    expect(turns.map((t: { text: string }) => t.text)).toEqual(["build the feature", "now add tests"]);
    // bt1 has no checkpoints and no file may change anyway.
    expect(readFileSync(join(workspace, "src", "a.txt"), "utf8")).toBe("a2\n");
  });

  it("also restores checkpoints of turns >= turn when files is true", async () => {
    const res = await post("/api/sessions/bt2/backtrack", { turn: 1, files: true });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      removedMessages: 4,
      keptMessages: 2,
      files: { restored: 1, deleted: 1, skipped: 0 },
    });

    // turn 0's file untouched; turn 1's restored; turn 2's creation undone.
    expect(readFileSync(join(workspace, "src", "a.txt"), "utf8")).toBe("a2\n");
    expect(readFileSync(join(workspace, "src", "b.txt"), "utf8")).toBe("b0\n");
    expect(existsSync(join(workspace, "src", "c.txt"))).toBe(false);
  });
});

describe("todos endpoints", () => {
  it("GET lists the seeded checklist lines (1-based, checklist-only indices)", async () => {
    const res = await authed("/api/todos");
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual([
      { index: 1, text: "first", done: false },
      { index: 2, text: "second", done: true },
    ]);
  });

  it("add/toggle/remove round-trip preserves headings and prose verbatim", async () => {
    let body = await jsonOf(await post("/api/todos", { op: "add", text: "third" }));
    expect(body).toEqual([
      { index: 1, text: "first", done: false },
      { index: 2, text: "second", done: true },
      { index: 3, text: "third", done: false },
    ]);

    body = await jsonOf(await post("/api/todos", { op: "toggle", index: 1 }));
    expect(body[0]).toEqual({ index: 1, text: "first", done: true });

    body = await jsonOf(await post("/api/todos", { op: "remove", index: 2 }));
    expect(body).toEqual([
      { index: 1, text: "first", done: true },
      { index: 2, text: "third", done: false },
    ]);

    const file = readFileSync(join(workspace, ".seekforge", "todos.md"), "utf8");
    expect(file).toBe(
      "# Project todos\n\nKeep shipping. This prose line must survive.\n- [x] first\n- [ ] third\n",
    );
  });

  it("validates op and index", async () => {
    expect((await post("/api/todos", { op: "nope" })).status).toBe(400);
    expect((await post("/api/todos", { op: "add", text: "  " })).status).toBe(400);
    expect((await post("/api/todos", { op: "toggle" })).status).toBe(400);
    expect((await post("/api/todos", { op: "toggle", index: 99 })).status).toBe(404);
    expect((await post("/api/todos", { op: "remove", index: 0 })).status).toBe(404);
  });
});

describe("GET /api/config engine knobs", () => {
  it("always exposes sandbox/compaction/thinking/reasoningEffort, no secrets", async () => {
    const body = await jsonOf(await authed("/api/config"));
    expect(body.sandbox).toBe("workspace-write");
    expect(body.compaction).toBe("mechanical"); // unset -> effective default
    expect(body.thinking).toBe(true);
    expect(body.reasoningEffort).toBe("max");
    expect(body.apiKey).toBeUndefined(); // none configured
    expect(body.mcpServers).toBeUndefined(); // never exposed here
  });
});

describe("GET /api/balance", () => {
  it("returns {balance: null} when no apiKey is configured", async () => {
    const res = await authed("/api/balance");
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ balance: null });
  });

  it("returns the parsed balance via a stubbed platform endpoint", async () => {
    // Stub the DeepSeek platform: the workspace's baseUrl points at it.
    const stub: Server = createServer((req, res) => {
      res.writeHead(req.url === "/user/balance" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "12.34" }] }));
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as { port: number }).port;

    const ws2 = makeWorkspace();
    writeFileIn(
      ws2,
      ".seekforge/config.json",
      JSON.stringify({ apiKey: "sk-balance-test", baseUrl: `http://127.0.0.1:${stubPort}` }),
    );
    const server2 = await startServer({ workspace: ws2, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    try {
      const res = await fetch(`http://127.0.0.1:${server2.port}/api/balance`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await jsonOf(res)).toEqual({ balance: { currency: "USD", totalBalance: "12.34" } });
    } finally {
      await server2.close();
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it("returns {balance: null} without any fetch for a provider lacking the balance capability (ark)", async () => {
    // Stub that records whether /user/balance is ever hit. For an ark provider
    // (capabilities.balance === false) it must not be — the key is never sent.
    let hit = false;
    const stub: Server = createServer((_req, res) => {
      hit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "99.00" }] }));
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as { port: number }).port;

    const wsArk = makeWorkspace();
    writeFileIn(
      wsArk,
      ".seekforge/config.json",
      JSON.stringify({ provider: "ark", apiKey: "sk-ark", baseUrl: `http://127.0.0.1:${stubPort}` }),
    );
    const serverArk = await startServer({ workspace: wsArk, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    try {
      const res = await fetch(`http://127.0.0.1:${serverArk.port}/api/balance`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ balance: null });
      expect(hit).toBe(false); // no fetch to /user/balance
    } finally {
      await serverArk.close();
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it("returns {balance: null} when the platform is unreachable (never an error)", async () => {
    const ws3 = makeWorkspace();
    // Port 9 (discard) is never listening locally -> fetch fails fast.
    writeFileIn(
      ws3,
      ".seekforge/config.json",
      JSON.stringify({ apiKey: "sk-balance-test", baseUrl: "http://127.0.0.1:9" }),
    );
    const server3 = await startServer({ workspace: ws3, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    try {
      const res = await fetch(`http://127.0.0.1:${server3.port}/api/balance`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ balance: null });
    } finally {
      await server3.close();
    }
  });
});

describe("GET /api/mcp/resources", () => {
  it("lists resources of reachable servers; broken servers contribute none", async () => {
    const res = await authed("/api/mcp/resources");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.resources).toEqual([
      { server: "fake", uri: "file:///docs/readme.md", name: "readme" },
      { server: "fake", uri: "file:///docs/plain.txt" },
    ]);
  });
});

describe("GET /api/mcp/prompts", () => {
  it("lists prompts of reachable servers; broken servers contribute none", async () => {
    const res = await authed("/api/mcp/prompts");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.prompts).toEqual([
      { server: "fake", name: "greet", description: "Greet someone.", arguments: [{ name: "who", required: true }] },
      { server: "fake", name: "summarize" },
    ]);
  });

  it("resolves one prompt with workspace-scoped arguments", async () => {
    const res = await post("/api/mcp/prompts/fake/greet", { arguments: { who: "Ada" } });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ text: "user: Hello Ada" });
  });
});
