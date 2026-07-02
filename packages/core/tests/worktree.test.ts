/**
 * Stateless git-worktree primitives against a real tmp git repo:
 * create -> exclude/branch/path, dirty + ahead status, list parsing,
 * merge (clean, dirty checkpoint, conflict+abort), and remove.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  isWorktreeDirty,
  listGitWorktrees,
  mergeWorktree,
  removeWorktree,
  worktreeAhead,
  worktreeBranchExists,
  WorktreeGitError,
  worktreeSlug,
} from "../src/worktree.js";

let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "seekforge-wt-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@seekforge.local");
  git(repo, "config", "user.name", "SeekForge Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("worktreeSlug", () => {
  it("slugifies names and falls back to a timestamp", () => {
    expect(worktreeSlug("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(worktreeSlug("  ---  ", new Date("2026-06-12T07:30:05Z"))).toBe("20260612-073005");
    expect(worktreeSlug(undefined, new Date("2026-06-12T07:30:05Z"))).toBe("20260612-073005");
  });
});

describe("createWorktree", () => {
  it("adds a checkout, excludes it, and returns path + branch", async () => {
    const { path, branch } = await createWorktree(repo, "feature-x");
    expect(path).toBe(join(repo, ".seekforge", "worktrees", "feature-x"));
    expect(branch).toBe("seekforge/feature-x");
    expect(existsSync(join(path, "base.txt"))).toBe(true);

    // info/exclude hides the checkouts so the base stays clean.
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".seekforge/worktrees/");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("is idempotent about the exclude line across multiple creates", async () => {
    await createWorktree(repo, "one");
    await createWorktree(repo, "two");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l.trim() === ".seekforge/worktrees/")).toHaveLength(1);
  });

  it("throws not_a_git_repo outside a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "seekforge-plain-"));
    try {
      await expect(createWorktree(plain, "nope")).rejects.toMatchObject({
        code: "not_a_git_repo",
      });
      await expect(createWorktree(plain, "nope")).rejects.toBeInstanceOf(WorktreeGitError);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("worktreeBranchExists", () => {
  it("reports whether the seekforge branch is present", async () => {
    expect(await worktreeBranchExists(repo, "probe")).toBe(false);
    await createWorktree(repo, "probe");
    expect(await worktreeBranchExists(repo, "probe")).toBe(true);
  });
});

describe("isWorktreeDirty + worktreeAhead", () => {
  it("tracks uncommitted changes and commits ahead of base HEAD", async () => {
    const { path, branch } = await createWorktree(repo, "status");
    expect(await isWorktreeDirty(path)).toBe(false);
    expect(await worktreeAhead(repo, branch)).toBe(0);

    writeFileSync(join(path, "new.txt"), "wip\n");
    expect(await isWorktreeDirty(path)).toBe(true);
    expect(await worktreeAhead(repo, branch)).toBe(0);

    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "work");
    expect(await isWorktreeDirty(path)).toBe(false);
    expect(await worktreeAhead(repo, branch)).toBe(1);
  });
});

describe("listGitWorktrees", () => {
  it("parses the main checkout plus every worktree", async () => {
    const { path, branch } = await createWorktree(repo, "listed");
    const entries = await listGitWorktrees(repo);
    // git resolves symlinks in paths (macOS /private/var), so compare basenames.
    const basename = (p: string) => p.split("/").pop();

    const main = entries.find((e) => e.branch === "main");
    expect(main).toBeDefined();
    expect(basename(main!.path)).toBe(basename(repo));
    expect(main!.head).toMatch(/^[0-9a-f]{40}$/);

    const wt = entries.find((e) => e.branch === "seekforge/listed");
    expect(wt).toBeDefined();
    expect(basename(wt!.path)).toBe(basename(path));
    expect(wt!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(branch).toBe("seekforge/listed");
  });
});

describe("mergeWorktree", () => {
  it("auto-commits a dirty worktree and merges it into the base", async () => {
    const { path, branch } = await createWorktree(repo, "lifecycle");
    writeFileSync(join(path, "feature.txt"), "made in the worktree\n");

    expect(await mergeWorktree(repo, path, branch)).toEqual({ merged: true });
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("made in the worktree\n");
    const log = git(repo, "log", "--format=%s");
    expect(log).toContain("seekforge worktree checkpoint");
    expect(log).toContain("merge seekforge/lifecycle (seekforge worktree)");
  });

  it("merges already-committed work without an extra checkpoint", async () => {
    const { path, branch } = await createWorktree(repo, "clean");
    writeFileSync(join(path, "clean.txt"), "committed\n");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "real commit");

    expect(await mergeWorktree(repo, path, branch)).toEqual({ merged: true });
    expect(git(repo, "log", "--format=%s")).not.toContain("seekforge worktree checkpoint");
    expect(readFileSync(join(repo, "clean.txt"), "utf8")).toBe("committed\n");
  });

  it("reports conflicts, aborts, and leaves the base clean", async () => {
    const { path, branch } = await createWorktree(repo, "conflict");
    writeFileSync(join(path, "base.txt"), "worktree version\n");
    writeFileSync(join(repo, "base.txt"), "base version\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "diverge in base");

    expect(await mergeWorktree(repo, path, branch)).toEqual({ conflict: true, files: ["base.txt"] });

    // Never left mid-merge.
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("base version\n");
    // The worktree checkpoint survives for the user to resolve/retry.
    expect(readFileSync(join(path, "base.txt"), "utf8")).toBe("worktree version\n");
  });
});

describe("removeWorktree", () => {
  it("removes the checkout and deletes the branch", async () => {
    const { path, branch } = await createWorktree(repo, "gone");
    await removeWorktree(repo, path, branch);
    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
  });
});
