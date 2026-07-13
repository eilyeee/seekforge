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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );

    await Promise.all([api.sessions("tab-workspace"), api.skills("tab-workspace"), api.agents("tab-workspace")]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions?ws=tab-workspace",
      "/api/skills?ws=tab-workspace",
      "/api/agents?ws=tab-workspace",
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
