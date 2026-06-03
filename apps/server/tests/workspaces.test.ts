import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { RunAgentTaskInput } from "@seekforge/core";
import { startServer, type RunningServer } from "../src/index.js";
import {
  collectFrames,
  connectWs,
  makeWorkspace,
  recordingAgentFactory,
  unusedAgentFactory,
  writeFileIn,
  type FrameCollector,
} from "./helpers.js";

const TOKEN = "test-token-ws-registry";

let server: RunningServer | undefined;
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = undefined;
});

/** Seeds a workspace with a single session whose id is `sid`. */
function seedSession(ws: string, sid: string, task: string): void {
  writeFileIn(
    ws,
    `.seekforge/sessions/${sid}/session.json`,
    JSON.stringify({
      id: sid,
      task,
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
  );
}

function seedSkill(ws: string, id: string): void {
  writeFileIn(
    ws,
    `.seekforge/skills/${id}/skill.json`,
    JSON.stringify({ id, name: id, description: "x", tags: [], triggers: [] }),
  );
  writeFileIn(ws, `.seekforge/skills/${id}/SKILL.md`, `# ${id}\n`);
}

function authed(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

async function open(port: number): Promise<{ ws: WebSocket; rx: FrameCollector }> {
  const ws = await connectWs(port, TOKEN);
  sockets.push(ws);
  return { ws, rx: collectFrames(ws) };
}

describe("workspace registry", () => {
  it("GET /api/workspaces lists all workspaces with id, name, path", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    server = await startServer({ workspaces: [a, b], port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await authed(base, "/api/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: Array<{ id: string; name: string; path: string }>;
      recents: unknown[];
    };
    const list = body.workspaces;
    expect(Array.isArray(body.recents)).toBe(true);
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.path)).toEqual([a, b]);
    expect(list.map((w) => w.name)).toEqual([basename(a), basename(b)]);
    for (const w of list) expect(typeof w.id).toBe("string");
    // ids are distinct and stable.
    expect(list[0]!.id).not.toBe(list[1]!.id);
  });

  it("GET /api/health includes the workspaces list and the default workspace", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    server = await startServer({ workspaces: [a, b], port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;

    const body = (await (await authed(base, "/api/health")).json()) as {
      workspace: string;
      workspaces: Array<{ path: string }>;
    };
    expect(body.workspace).toBe(a);
    expect(body.workspaces.map((w) => w.path)).toEqual([a, b]);
  });

  it("?ws= routes sessions/skills to the right workspace (isolation)", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    seedSession(a, "a1", "task in A");
    seedSession(b, "b1", "task in B");
    seedSkill(a, "skill-a");
    seedSkill(b, "skill-b");
    server = await startServer({ workspaces: [a, b], port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;

    const ids = ((await (await authed(base, "/api/workspaces")).json()) as { workspaces: Array<{ id: string }> })
      .workspaces;
    const [idA, idB] = [ids[0]!.id, ids[1]!.id];

    const sessA = (await (await authed(base, `/api/sessions?ws=${idA}`)).json()) as Array<{ id: string }>;
    const sessB = (await (await authed(base, `/api/sessions?ws=${idB}`)).json()) as Array<{ id: string }>;
    expect(sessA.map((s) => s.id)).toEqual(["a1"]);
    expect(sessB.map((s) => s.id)).toEqual(["b1"]);

    // Skills include builtins; filter to project scope to assert isolation.
    const skillsA = (await (await authed(base, `/api/skills?ws=${idA}`)).json()) as Array<{
      id: string;
      scope: string;
    }>;
    const skillsB = (await (await authed(base, `/api/skills?ws=${idB}`)).json()) as Array<{
      id: string;
      scope: string;
    }>;
    expect(skillsA.filter((s) => s.scope === "project").map((s) => s.id)).toEqual(["skill-a"]);
    expect(skillsB.filter((s) => s.scope === "project").map((s) => s.id)).toEqual(["skill-b"]);
  });

  it("?ws= routes memory writes to the right workspace", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    const cand = {
      id: "c1",
      content: "fact for A",
      type: "tech",
      confidence: 0.9,
      sourceSessionId: "a1",
      createdAt: "2026-01-02T00:00:00.000Z",
      status: "pending",
    };
    writeFileIn(a, ".seekforge/memory/candidates.jsonl", `${JSON.stringify(cand)}\n`);
    server = await startServer({ workspaces: [a, b], port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;
    const ids = ((await (await authed(base, "/api/workspaces")).json()) as { workspaces: Array<{ id: string }> })
      .workspaces;
    const [idA, idB] = [ids[0]!.id, ids[1]!.id];

    // Workspace B has no candidates.
    const memB = (await (await authed(base, `/api/memory?ws=${idB}`)).json()) as { candidates: unknown[] };
    expect(memB.candidates).toHaveLength(0);

    // Approving in A writes A's project.md, not B's.
    const approved = await authed(base, `/api/memory/c1/approve?ws=${idA}`, { method: "POST" });
    expect(approved.status).toBe(200);
    const memA = (await (await authed(base, `/api/memory?ws=${idA}`)).json()) as { projectMd: string | null };
    expect(memA.projectMd).toContain("fact for A");
  });

  it("omitted ?ws= falls back to the first workspace (back-compat)", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    seedSession(a, "a1", "task in A");
    server = await startServer({ workspaces: [a, b], port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;

    const sessions = (await (await authed(base, "/api/sessions")).json()) as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual(["a1"]);
  });

  it("unknown ?ws= id is 404", async () => {
    const a = makeWorkspace();
    server = await startServer({ workspace: a, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await authed(base, "/api/sessions?ws=nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("WS workspace targeting", () => {
  it("start with ws= runs in that workspace; omitted ws uses the first", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    const inputs: RunAgentTaskInput[] = [];
    server = await startServer({
      workspaces: [a, b],
      port: 0,
      token: TOKEN,
      createAgent: recordingAgentFactory(inputs),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const ids = ((await (await authed(base, "/api/workspaces")).json()) as { workspaces: Array<{ id: string }> })
      .workspaces;
    const idB = ids[1]!.id;

    const { ws, rx } = await open(server.port);
    ws.send(JSON.stringify({ type: "start", task: "in B", mode: "edit", approvalMode: "auto", ws: idB }));
    await rx.waitFor((f) => f.type === "idle");
    expect(inputs[0]!.projectPath).toBe(b);

    ws.send(JSON.stringify({ type: "start", task: "default", mode: "edit", approvalMode: "auto" }));
    await rx.waitFor((f) => f.type === "idle");
    expect(inputs[1]!.projectPath).toBe(a);
  });

  it("send resumes a session in the targeted workspace", async () => {
    const a = makeWorkspace();
    const b = makeWorkspace();
    seedSession(b, "b1", "task in B");
    const inputs: RunAgentTaskInput[] = [];
    server = await startServer({
      workspaces: [a, b],
      port: 0,
      token: TOKEN,
      createAgent: recordingAgentFactory(inputs),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const ids = ((await (await authed(base, "/api/workspaces")).json()) as { workspaces: Array<{ id: string }> })
      .workspaces;
    const idB = ids[1]!.id;

    const { ws, rx } = await open(server.port);
    // The session exists only in B; resuming it with ws=A must fail.
    ws.send(JSON.stringify({ type: "send", sessionId: "b1", task: "go on", ws: ids[0]!.id }));
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_session");

    ws.send(JSON.stringify({ type: "send", sessionId: "b1", task: "go on", ws: idB }));
    await rx.waitFor((f) => f.type === "idle");
    expect(inputs[0]!.projectPath).toBe(b);
    expect(inputs[0]!.resumeSessionId).toBe("b1");
  });

  it("start with an unknown ws id is a protocol error", async () => {
    const a = makeWorkspace();
    server = await startServer({ workspace: a, port: 0, token: TOKEN, createAgent: recordingAgentFactory([]) });
    const { ws, rx } = await open(server.port);
    ws.send(JSON.stringify({ type: "start", task: "x", mode: "edit", approvalMode: "auto", ws: "nope" }));
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_workspace");
  });
});
