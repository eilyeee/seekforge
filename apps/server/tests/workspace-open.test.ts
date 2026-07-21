import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { acquireSessionLease } from "@seekforge/core";
import {
  forgetRecent,
  loadRecents,
  rememberRecent,
  isWorkspaceDir,
  MAX_RECENTS_FILE_BYTES,
  recentsFilePath,
} from "../src/recents.js";
import { makeWorkspace, unusedAgentFactory } from "./helpers.js";

const TOKEN = "test-token-ws-open";

let prevHome: string | undefined;
let home: string;
let workspace: string;
let other: string;
let server: RunningServer;
let base: string;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

type WsEntry = { id: string; name: string; path: string };
type WsBody = { workspaces: WsEntry[]; recents: Array<{ name: string; path: string }>; workspace?: WsEntry };
async function jsonOf(res: Response): Promise<WsBody> {
  return (await res.json()) as WsBody;
}

beforeAll(async () => {
  // Isolate the recents file (~/.seekforge/workspaces.json) to a throwaway home.
  prevHome = process.env["SEEKFORGE_HOME"];
  home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
  process.env["SEEKFORGE_HOME"] = home;
  workspace = makeWorkspace();
  other = makeWorkspace();
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (prevHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = prevHome;
});

describe("recents store", () => {
  it("remembers (newest-first, de-duplicated) and forgets", () => {
    rememberRecent("/tmp/a");
    rememberRecent("/tmp/b");
    rememberRecent("/tmp/a"); // re-open moves it to the front
    expect(
      loadRecents()
        .map((r) => r.path)
        .slice(0, 2),
    ).toEqual(["/tmp/a", "/tmp/b"]);
    forgetRecent("/tmp/a");
    expect(loadRecents().some((r) => r.path === "/tmp/a")).toBe(false);
  });

  it("isWorkspaceDir is true for a directory, false for a missing path", () => {
    expect(isWorkspaceDir(workspace)).toBe(true);
    expect(isWorkspaceDir(join(workspace, "does-not-exist"))).toBe(false);
  });

  it("normalizes non-finite recent timestamps", () => {
    writeFileSync(recentsFilePath(), '{"recents":[{"path":"/tmp/poisoned","lastOpened":1e999}]}');
    expect(loadRecents()).toEqual([{ path: "/tmp/poisoned", name: "poisoned", lastOpened: 0 }]);
  });

  it("does not overwrite an oversized recents file during mutation", () => {
    const file = recentsFilePath();
    writeFileSync(file, Buffer.alloc(MAX_RECENTS_FILE_BYTES + 1, 0x20));
    expect(loadRecents()).toEqual([]);
    expect(() => rememberRecent("/tmp/must-not-replace")).toThrow(/exceeds/);
    expect(readFileSync(file).length).toBe(MAX_RECENTS_FILE_BYTES + 1);
    writeFileSync(file, '{"recents":[]}');
  });
});

describe("workspace open/remove endpoints", () => {
  it("GET /api/workspaces returns hosted workspaces + recents", async () => {
    const body = await jsonOf(await authed("/api/workspaces"));
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces[0]!.path).toBe(workspace);
    expect(Array.isArray(body.recents)).toBe(true);
  });

  it("POST /api/workspaces registers a folder and remembers it", async () => {
    const res = await authed("/api/workspaces", { method: "POST", body: JSON.stringify({ path: other }) });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.workspace!.path).toBe(other);
    expect(body.workspaces.some((w) => w.path === other)).toBe(true);
    // Persisted to the recents file under the isolated home.
    expect(recentsFilePath().startsWith(realpathSync(home))).toBe(true);
    expect(JSON.parse(readFileSync(recentsFilePath(), "utf8")).recents[0].path).toBe(other);
  });

  it("POST with a non-directory path is a 400", async () => {
    const res = await authed("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path: join(workspace, "nope") }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/workspaces/:id stops hosting (default cannot be removed)", async () => {
    // Re-open `other` so it is hosted again (a prior test may have removed it).
    await authed("/api/workspaces", { method: "POST", body: JSON.stringify({ path: other }) });
    const list = await jsonOf(await authed("/api/workspaces"));
    const target = list.workspaces.find((w) => w.path === other)!;
    const res = await authed(`/api/workspaces/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.workspaces.some((w) => w.path === other)).toBe(false);

    // The default (first) workspace cannot be unregistered.
    const def = body.workspaces[0]!;
    const bad = await authed(`/api/workspaces/${def.id}`, { method: "DELETE" });
    expect(bad.status).toBe(400);
  });

  it("DELETE /api/workspaces/:id refuses worktree ids (must use the worktree flow)", async () => {
    const res = await authed("/api/workspaces/wt-something", { method: "DELETE" });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/worktree/i);
  });

  it("DELETE /api/workspaces/:id refuses a workspace with an active agent session", async () => {
    await authed("/api/workspaces", { method: "POST", body: JSON.stringify({ path: other }) });
    const target = (await jsonOf(await authed("/api/workspaces"))).workspaces.find((w) => w.path === other)!;
    const lease = acquireSessionLease(other, "active-workspace-close");
    try {
      const res = await authed(`/api/workspaces/${target.id}`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_busy");
      expect((await jsonOf(await authed("/api/workspaces"))).workspaces.some((w) => w.id === target.id)).toBe(true);
    } finally {
      lease.release();
    }
  });

  it("DELETE /api/workspaces/recent forgets a recent path", async () => {
    rememberRecent("/tmp/forget-me");
    const res = await authed(`/api/workspaces/recent?path=${encodeURIComponent("/tmp/forget-me")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(loadRecents().some((r) => r.path === "/tmp/forget-me")).toBe(false);
  });
});
