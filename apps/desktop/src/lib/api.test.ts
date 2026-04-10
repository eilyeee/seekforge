import { afterEach, describe, expect, it } from "vitest";
import { setWorkspaceProvider, withWorkspace } from "./api";

afterEach(() => {
  // Reset to the default (no active workspace) between tests.
  setWorkspaceProvider(() => "");
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
