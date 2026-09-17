// Cross-lane wiring on the server: skill sources, remote plugin sources,
// manual compaction hooks, gitignore-aware file search, the token file, and
// the session-scoped dispatch registry.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSessionTrace, PLUGIN_API_VERSION } from "@seekforge/core";
import { clearFilesCacheForTests } from "../src/files.js";
import { readServerTokenFile, startServer, type RunningServer } from "../src/index.js";
import { SessionDispatchRegistry } from "../src/session-dispatch.js";
import { removeServerTokenFile, writeServerTokenFile } from "../src/token-file.js";
import { makeWorkspace, unusedAgentFactory, waitUntil, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-integration";
const savedHome = process.env["SEEKFORGE_HOME"];
let home: string;
let workspace: string;
let server: RunningServer;
let base: string;

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text === "" ? null : JSON.parse(text)) as any };
}

function writeUserConfig(config: Record<string, unknown>): void {
  writeFileIn(home, ".seekforge/config.json", JSON.stringify(config));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, LC_ALL: "C" }, stdio: "ignore" });
}

beforeAll(async () => {
  home = makeWorkspace();
  workspace = makeWorkspace();
  process.env["SEEKFORGE_HOME"] = home;
  writeUserConfig({});
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (savedHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = savedHome;
});

describe("skill sources", () => {
  it("lists ~/.claude/skills exactly while claudeUserSkills is on", async () => {
    writeFileIn(home, ".claude/skills/claude-only/SKILL.md", "---\ndescription: From Claude Code\n---\nBody\n");
    const ids = async () => ((await call("/api/skills")).json as Array<{ id: string }>).map((skill) => skill.id);
    expect(await ids()).not.toContain("claude-only");
    writeUserConfig({ claudeUserSkills: true });
    expect(await ids()).toContain("claude-only");
    expect((await call("/api/skills/claude-only")).status).toBe(200);
    writeUserConfig({});
    expect(await ids()).not.toContain("claude-only");
  });
});

describe("POST /api/plugins/install sources", () => {
  it("installs from a repository URL, disabled, with its provenance", async () => {
    const repo = makeWorkspace();
    writeFileIn(
      repo,
      "plugin.json",
      JSON.stringify({ apiVersion: PLUGIN_API_VERSION, id: "remote-demo", name: "remote-demo", version: "1.0.0" }),
    );
    git(repo, "init", "-q");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "add", "plugin.json");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init");
    const res = await call("/api/plugins/install", { method: "POST", body: { source: `file://${repo}` } });
    expect(res.status).toBe(200);
    expect(res.json.manifest.id).toBe("remote-demo");
    expect(res.json.origin).toMatchObject({ kind: "git", url: `file://${repo}` });
    expect(res.json.originLabel).toMatch(/^git file:\/\/.+ @ [0-9a-f]{40}$/);
    const plugins = (await call("/api/plugins")).json as Array<{ id: string; status: string }>;
    expect(plugins.find((plugin) => plugin.id === "remote-demo")?.status).toBe("disabled");
  });

  it("refuses an unencrypted source and a malformed body", async () => {
    const insecure = await call("/api/plugins/install", {
      method: "POST",
      body: { source: "http://example.invalid/p.tar.gz" },
    });
    expect(insecure.status).toBe(400);
    expect(insecure.json.error.message).toContain("unencrypted");
    expect((await call("/api/plugins/install", { method: "POST", body: { source: 42 } })).status).toBe(400);
  });
});

describe("POST /api/sessions/:id/compact runs the compaction hooks", () => {
  const seed = (id: string): void => {
    const trace = createSessionTrace(workspace, id);
    trace.message({ role: "system", content: "system prompt" });
    trace.message({ role: "user", content: "the task" });
    for (let i = 0; i < 20; i += 1) {
      trace.message({ role: "assistant", content: `turn ${i} ${"x".repeat(200)}` });
      trace.message({ role: "user", content: `reply ${i}` });
    }
    writeFileIn(
      workspace,
      `.seekforge/sessions/${id}/session.json`,
      JSON.stringify({
        id,
        task: "the task",
        mode: "edit",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  };

  afterEach(() => writeUserConfig({}));

  it("reports a preCompact refusal as 409 and changes nothing", async () => {
    seed("hook-block");
    const before = readFileSync(join(workspace, ".seekforge/sessions/hook-block/messages.jsonl"), "utf8");
    writeUserConfig({
      hooks: {
        preCompact: [{ command: `printf '%s' '{"decision":"block","reason":"export first"}'` }],
      },
    });
    const res = await call("/api/sessions/hook-block/compact", { method: "POST" });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      error: { code: "blocked_by_hook", message: "export first" },
      blocked: true,
      reason: "export first",
      notices: [],
    });
    expect(readFileSync(join(workspace, ".seekforge/sessions/hook-block/messages.jsonl"), "utf8")).toBe(before);
  });

  it("compacts and returns the hooks' notices", async () => {
    seed("hook-notice");
    writeUserConfig({
      hooks: {
        preCompact: [{ command: `printf '%s' '{"systemMessage":"saved a copy"}'` }],
        postCompact: [{ command: "cat > post-compact.json" }],
      },
    });
    const res = await call("/api/sessions/hook-notice/compact", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ droppedTurns: expect.any(Number), notices: ["saved a copy"] });
    expect(JSON.parse(readFileSync(join(workspace, "post-compact.json"), "utf8"))).toMatchObject({
      stage: "postCompact",
      reason: "manual",
      sessionId: "hook-notice",
    });
  });
});

describe("file index and search honor .gitignore", () => {
  it("skips ignored paths on top of the built-in floor", async () => {
    const repo = makeWorkspace();
    git(repo, "init", "-q");
    writeFileIn(repo, ".gitignore", "generated/\n*.log\n!keep.log\n");
    writeFileIn(repo, "src/app.ts", "needle\n");
    writeFileIn(repo, "src/.gitignore", "local.ts\n");
    writeFileIn(repo, "src/local.ts", "needle\n");
    writeFileIn(repo, "generated/out.ts", "needle\n");
    writeFileIn(repo, "debug.log", "needle\n");
    writeFileIn(repo, "keep.log", "needle\n");
    // The floor holds even when a rule tries to re-include it.
    writeFileIn(repo, "node_modules/pkg/index.js", "needle\n");
    writeFileIn(repo, ".gitignore", "generated/\n*.log\n!keep.log\n!node_modules/\n");
    const other = await startServer({ workspace: repo, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    try {
      clearFilesCacheForTests();
      const at = `http://127.0.0.1:${other.port}`;
      const get = async (path: string) =>
        (await (await fetch(`${at}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any;
      const files = (await get("/api/files")).files as string[];
      expect(files.sort()).toEqual([".gitignore", "keep.log", "src/.gitignore", "src/app.ts"]);
      const hits = ((await get("/api/search?q=needle")).hits as Array<{ path: string }>).map((hit) => hit.path);
      expect(hits.sort()).toEqual(["keep.log", "src/app.ts"]);
    } finally {
      await other.close();
    }
  });
});

describe("token file", () => {
  it("is written 0600 while the server runs and removed on close", async () => {
    const dir = makeWorkspace();
    const path = join(dir, "nested", "serve.json");
    const other = await startServer({
      workspace,
      port: 0,
      token: "token-file-secret",
      createAgent: unusedAgentFactory,
      tokenFile: path,
    });
    const content = readServerTokenFile(path);
    expect(content).toEqual({
      version: 1,
      port: other.port,
      token: "token-file-secret",
      pid: process.pid,
      url: `http://127.0.0.1:${other.port}/?token=token-file-secret`,
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await other.close();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a file that another server has since written, and replaces a planted symlink", () => {
    const dir = makeWorkspace();
    const path = join(dir, "serve.json");
    writeServerTokenFile(path, { port: 1, token: "first" });
    writeServerTokenFile(path, { port: 2, token: "second" });
    removeServerTokenFile(path, "first");
    expect(readServerTokenFile(path)?.token).toBe("second");
    removeServerTokenFile(path, "second");
    expect(existsSync(path)).toBe(false);

    const target = join(dir, "victim.txt");
    writeFileSync(target, "untouched\n");
    execFileSync("ln", ["-s", target, path]);
    writeServerTokenFile(path, { port: 3, token: "third" });
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(readServerTokenFile(path)?.token).toBe("third");
    expect(() => writeServerTokenFile(dir, { port: 4, token: "x" })).toThrow(/directory/);
  });

  it("refuses to start when the token file cannot be written", async () => {
    const dir = makeWorkspace();
    await expect(
      startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory, tokenFile: dir }),
    ).rejects.toThrow(/directory/);
  });
});

describe("SessionDispatchRegistry", () => {
  const background = (registry: SessionDispatchRegistry, session: string) => {
    const manager = registry.attach("/ws", session);
    let finish: (() => void) | undefined;
    manager.start({
      agentId: "a",
      task: "t",
      background: true,
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, data: null });
        }),
    });
    return {
      manager,
      finish: async () => {
        await waitUntil(() => finish !== undefined);
        finish!();
      },
    };
  };

  it("hands a session the manager it already has", () => {
    const registry = new SessionDispatchRegistry();
    const fresh = registry.create();
    expect(fresh.sessionScoped).toBe(true);
    expect(registry.attach("/ws", "s1", fresh)).toBe(fresh);
    expect(registry.attach("/ws", "s1", registry.create())).toBe(fresh);
    expect(registry.attach("/other", "s1")).not.toBe(fresh);
    expect(registry.get("/ws", "s1")).toBe(fresh);
  });

  it("evicts only idle sessions beyond the cap", async () => {
    const registry = new SessionDispatchRegistry(2, 10);
    const busy = background(registry, "busy");
    registry.release("/ws", "busy", () => {});
    registry.attach("/ws", "in-use");
    registry.attach("/ws", "idle");
    registry.release("/ws", "idle", () => {});
    registry.attach("/ws", "newest");
    registry.release("/ws", "newest", () => {});
    // "busy" has a running dispatch and "in-use" a running run: both stay.
    expect(registry.get("/ws", "busy")).toBe(busy.manager);
    expect(registry.get("/ws", "in-use")).toBeDefined();
    expect(registry.get("/ws", "idle")).toBeUndefined();
    expect(registry.size).toBe(3);
    await busy.finish();
    await waitUntil(() => busy.manager.get("ag-1")?.status === "done");
  });

  it("releases immediately once closed, and runs every deferred release on shutdown", async () => {
    const registry = new SessionDispatchRegistry(8, 60_000);
    const pending = background(registry, "s");
    const released: string[] = [];
    registry.release("/ws", "s", () => released.push("first"));
    registry.attach("/ws", "s");
    registry.release("/ws", "s", () => {
      throw new Error("a failing release must not block the others");
    });
    registry.release("/ws", "s", () => released.push("third"));
    expect(released).toEqual([]);
    registry.disposeAll();
    expect(released).toEqual(["first", "third"]);
    expect(pending.manager.get("ag-1")?.status).toBe("cancelled");
    registry.release("/ws", "s", () => released.push("after"));
    expect(released).toEqual(["first", "third", "after"]);
    registry.close("/ws", "unknown");
  });
});
