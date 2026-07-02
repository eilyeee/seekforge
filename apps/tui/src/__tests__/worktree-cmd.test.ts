import { describe, expect, it } from "vitest";
import type { GitWorktreeEntry } from "@seekforge/core";
import {
  parseWorktreeCommand,
  pickFreeSlug,
  resolveWorktreeTarget,
  seekforgeWorktrees,
  slugOfBranch,
} from "../worktree-cmd.js";

function entry(branch: string, path = `/repo/.seekforge/worktrees/${branch.split("/").pop()}`): GitWorktreeEntry {
  return { branch, path, head: "abc123" };
}

describe("parseWorktreeCommand", () => {
  it("treats bare/blank input as usage", () => {
    expect(parseWorktreeCommand(undefined)).toEqual({ kind: "usage" });
    expect(parseWorktreeCommand("   ")).toEqual({ kind: "usage" });
  });

  it("parses list (and its ls alias)", () => {
    expect(parseWorktreeCommand("list")).toEqual({ kind: "list" });
    expect(parseWorktreeCommand("ls")).toEqual({ kind: "list" });
  });

  it("parses new with and without a name (joining extra words)", () => {
    expect(parseWorktreeCommand("new")).toEqual({ kind: "new" });
    expect(parseWorktreeCommand("new my feature")).toEqual({ kind: "new", name: "my feature" });
    expect(parseWorktreeCommand("add spike")).toEqual({ kind: "new", name: "spike" });
  });

  it("parses remove taking the first token as the target", () => {
    expect(parseWorktreeCommand("remove")).toEqual({ kind: "remove" });
    expect(parseWorktreeCommand("remove foo")).toEqual({ kind: "remove", target: "foo" });
    expect(parseWorktreeCommand("rm seekforge/foo extra")).toEqual({ kind: "remove", target: "seekforge/foo" });
  });

  it("falls back to usage for unknown subcommands", () => {
    expect(parseWorktreeCommand("frobnicate")).toEqual({ kind: "usage" });
  });
});

describe("slugOfBranch / seekforgeWorktrees", () => {
  it("extracts the slug only for seekforge branches", () => {
    expect(slugOfBranch("seekforge/foo")).toBe("foo");
    expect(slugOfBranch("main")).toBe("");
  });

  it("filters to seekforge-managed worktrees", () => {
    const entries = [entry("main", "/repo"), entry("seekforge/foo"), entry("feature/x", "/repo/wt")];
    expect(seekforgeWorktrees(entries).map((e) => e.branch)).toEqual(["seekforge/foo"]);
  });
});

describe("pickFreeSlug", () => {
  it("uses the timestamp fallback for an empty name", async () => {
    const now = new Date("2026-06-12T15:30:00Z");
    const slug = await pickFreeSlug(undefined, async () => false, { now });
    expect(slug).toBe("20260612-153000");
  });

  it("slugifies a provided name", async () => {
    const slug = await pickFreeSlug("My Feature!", async () => false);
    expect(slug).toBe("my-feature");
  });

  it("bumps -2, -3 … past collisions", async () => {
    const taken = new Set(["fix", "fix-2"]);
    const slug = await pickFreeSlug("fix", async (s) => taken.has(s));
    expect(slug).toBe("fix-3");
  });

  it("throws when no free slug is found within the bound", async () => {
    await expect(pickFreeSlug("x", async () => true, { maxAttempts: 3 })).rejects.toThrow(/free worktree slug/);
  });
});

describe("resolveWorktreeTarget", () => {
  const entries = [entry("main", "/repo"), entry("seekforge/foo"), entry("seekforge/bar")];

  it("matches by slug", () => {
    expect(resolveWorktreeTarget(entries, "foo")?.branch).toBe("seekforge/foo");
  });

  it("matches by full branch", () => {
    expect(resolveWorktreeTarget(entries, "seekforge/bar")?.branch).toBe("seekforge/bar");
  });

  it("matches by the branch's last path segment", () => {
    expect(resolveWorktreeTarget(entries, "bar")?.branch).toBe("seekforge/bar");
  });

  it("never resolves a non-seekforge worktree", () => {
    expect(resolveWorktreeTarget(entries, "main")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveWorktreeTarget(entries, "nope")).toBeUndefined();
    expect(resolveWorktreeTarget(entries, "  ")).toBeUndefined();
  });
});
