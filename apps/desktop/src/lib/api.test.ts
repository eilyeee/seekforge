import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setTokenProvider, setWorkspaceProvider, withWorkspace } from "./api";

afterEach(() => {
  // Reset to the default (no active workspace) between tests.
  setWorkspaceProvider(() => "");
  setTokenProvider(() => "");
  vi.restoreAllMocks();
});

describe("withWorkspace", () => {
  it("appends ?ws=<active> to a query-less path", () => {
    setWorkspaceProvider(() => "ws-a");
    expect(withWorkspace("/api/sessions")).toBe("/api/sessions?ws=ws-a");
  });

  it("uses & when the path already has a query string", () => {
    setWorkspaceProvider(() => "ws-a");
    expect(withWorkspace("/api/diff?staged=1")).toBe("/api/diff?staged=1&ws=ws-a");
  });

  it("omits ws when no workspace is active (back-compat default)", () => {
    setWorkspaceProvider(() => "");
    expect(withWorkspace("/api/sessions")).toBe("/api/sessions");
    expect(withWorkspace("/api/diff?staged=1")).toBe("/api/diff?staged=1");
  });

  it("an explicit id overrides the active workspace", () => {
    setWorkspaceProvider(() => "ws-active");
    expect(withWorkspace("/api/skills", "ws-explicit")).toBe("/api/skills?ws=ws-explicit");
    // undefined (not passed) falls back to the active workspace.
    expect(withWorkspace("/api/skills")).toBe("/api/skills?ws=ws-active");
    // An explicit empty id means "no ws" (server default), even when one is active.
    expect(withWorkspace("/api/skills", "")).toBe("/api/skills");
  });

  it("url-encodes the workspace id", () => {
    setWorkspaceProvider(() => "a b");
    expect(withWorkspace("/api/memory")).toBe("/api/memory?ws=a%20b");
  });
});

describe("tab-scoped home requests", () => {
  it("uses the explicit tab workspace for recents instead of the active workspace", async () => {
    setWorkspaceProvider(() => "active-workspace");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      );

    await Promise.all([api.sessions("tab-workspace"), api.skills("tab-workspace"), api.agents("tab-workspace")]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions?ws=tab-workspace",
      "/api/skills?ws=tab-workspace",
      "/api/agents?ws=tab-workspace",
    ]);
  });
});

describe("captured workspace routing", () => {
  it("keeps view reads and mutations on the explicitly captured workspace", async () => {
    setWorkspaceProvider(() => "new-active-workspace");
    const calls: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    const ws = "captured-workspace";
    await api.diff(true, ws);
    await api.evolution(ws);
    await api.evolutionAction("proposal/1", "accept", ws);
    await api.evolutionApply("proposal/1", ws);
    await api.skill("skill/1", ws);
    await api.skillSetEnabled("skill/1", false, "project", ws);
    await api.skillCreate("new-skill", ws);
    await api.skillImport("/tmp/SKILL.md", false, ws);
    await api.skillDelete("skill/1", "project", ws);
    await api.skillStats(ws);
    await api.skillRepair(false, "skill/1", ws);
    await api.doctor(ws);
    await api.tree("src dir", ws);
    await api.readFile("src/a b.ts", ws);
    await api.writeFile("src/a.ts", "next", ws);
    await api.gitStatus(ws);
    await api.gitStage(["a.ts"], ws);
    await api.gitUnstage(["a.ts"], ws);
    await api.gitDiscard(["a.ts"], ws);
    await api.gitCommit("fix", ws);
    await api.hooks(ws);
    await api.saveHooks({}, ws);
    await api.setConfig("model", "deepseek-v4-flash", false, ws);

    expect(calls).toEqual([
      { url: "/api/diff?staged=1&ws=captured-workspace", method: "GET" },
      { url: "/api/evolution?ws=captured-workspace", method: "GET" },
      { url: "/api/evolution/proposal%2F1/accept?ws=captured-workspace", method: "POST" },
      { url: "/api/evolution/proposal%2F1/apply?ws=captured-workspace", method: "POST" },
      { url: "/api/skills/skill%2F1?ws=captured-workspace", method: "GET" },
      { url: "/api/skills/skill%2F1?ws=captured-workspace", method: "PUT" },
      { url: "/api/skills?ws=captured-workspace", method: "POST" },
      { url: "/api/skills/import?ws=captured-workspace", method: "POST" },
      { url: "/api/skills/skill%2F1?scope=project&ws=captured-workspace", method: "DELETE" },
      { url: "/api/skills/stats?ws=captured-workspace", method: "GET" },
      { url: "/api/skills/repair?ws=captured-workspace", method: "POST" },
      { url: "/api/doctor?ws=captured-workspace", method: "GET" },
      { url: "/api/tree?path=src%20dir&ws=captured-workspace", method: "GET" },
      { url: "/api/file?path=src%2Fa%20b.ts&ws=captured-workspace", method: "GET" },
      { url: "/api/file?ws=captured-workspace", method: "PUT" },
      { url: "/api/git/status?ws=captured-workspace", method: "GET" },
      { url: "/api/git/stage?ws=captured-workspace", method: "POST" },
      { url: "/api/git/unstage?ws=captured-workspace", method: "POST" },
      { url: "/api/git/discard?ws=captured-workspace", method: "POST" },
      { url: "/api/git/commit?ws=captured-workspace", method: "POST" },
      { url: "/api/hooks?ws=captured-workspace", method: "GET" },
      { url: "/api/hooks?ws=captured-workspace", method: "PUT" },
      { url: "/api/config?ws=captured-workspace", method: "PUT" },
    ]);
  });
});

describe("api.rawUrl", () => {
  // These tests run outside mock mode (no window in jsdom-less node env / no
  // ?mock=1), so rawUrl hits the real-route branch.
  it("builds /api/raw?path= with the encoded path and active ws + token", () => {
    setWorkspaceProvider(() => "ws-a");
    setTokenProvider(() => "tok123");
    expect(api.rawUrl(".seekforge/uploads/img-1.png")).toBe(
      "/api/raw?path=.seekforge%2Fuploads%2Fimg-1.png&ws=ws-a&token=tok123",
    );
  });

  it("omits ws when none is active, and omits the token when empty", () => {
    setWorkspaceProvider(() => "");
    setTokenProvider(() => "");
    expect(api.rawUrl(".seekforge/uploads/a.png")).toBe("/api/raw?path=.seekforge%2Fuploads%2Fa.png");
  });

  it("an explicit ws overrides the active workspace", () => {
    setWorkspaceProvider(() => "active");
    setTokenProvider(() => "");
    expect(api.rawUrl("x.png", "explicit")).toBe("/api/raw?path=x.png&ws=explicit");
    // An explicit empty ws means the server default (no ws param).
    expect(api.rawUrl("x.png", "")).toBe("/api/raw?path=x.png");
  });
});
