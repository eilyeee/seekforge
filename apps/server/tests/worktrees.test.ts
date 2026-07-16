/**
 * Worktree session lifecycle against a real tmp git repo:
 * create -> registered in /api/workspaces -> work in the worktree workspace ->
 * merge back (incl. dirty auto-commit and conflict abort) -> delete/unregister.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { acquireSessionLease } from "@seekforge/core";
import { worktreeSlug } from "../src/worktrees.js";
import { ServerCoordinator } from "../src/coordinator.js";
import { makeWorkspace, unusedAgentFactory, waitUntil } from "./helpers.js";

// These tests drive real `git worktree` operations against tmp repos. Under the
// full parallel `pnpm -r test` run, filesystem/git I/O contention can push a
// single test past vitest's default 5s timeout (observed ~27s under load),
// producing a timeout flake even though the logic is correct. Raise the
// per-test timeout for THIS FILE ONLY (vi.setConfig is file-scoped) so other
// suites keep the fast default and we don't serialize the whole run.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TOKEN = "test-token-worktrees";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Tmp dir turned into a git repo with one commit (identity configured locally). */
function makeGitRepo(): string {
  const repo = makeWorkspace();
  gitIn(repo, "init", "-b", "main");
  gitIn(repo, "config", "user.email", "test@seekforge.local");
  gitIn(repo, "config", "user.name", "SeekForge Test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "initial");
  return repo;
}

async function boot(repo: string): Promise<string> {
  server = await startServer({ workspace: repo, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  return `http://127.0.0.1:${server.port}`;
}

function authed(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

async function createWorktree(base: string, name?: string) {
  const res = await authed(base, "/api/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; path: string; branch: string };
}

describe("worktreeSlug", () => {
  it("slugifies names and falls back to a timestamp", () => {
    expect(worktreeSlug("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(worktreeSlug("  ---  ", new Date("2026-06-12T07:30:05Z"))).toBe("20260612-073005");
    expect(worktreeSlug(undefined, new Date("2026-06-12T07:30:05Z"))).toBe("20260612-073005");
  });
});

describe("POST /api/worktrees", () => {
  it("creates a worktree, registers it as a workspace, excludes it from git status", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);

    const wt = await createWorktree(base, "Feature X");
    expect(wt.id).toBe("wt-feature-x");
    expect(wt.branch).toBe("seekforge/feature-x");
    expect(wt.path).toBe(join(repo, ".seekforge", "worktrees", "feature-x"));
    expect(existsSync(join(wt.path, "base.txt"))).toBe(true);

    // Registered as a workspace -> all ?ws= scoping works against it.
    const workspaces = (
      (await (await authed(base, "/api/workspaces")).json()) as {
        workspaces: Array<{ id: string; path: string; name: string }>;
      }
    ).workspaces;
    expect(workspaces.map((w) => w.id)).toContain("wt-feature-x");
    expect(workspaces.find((w) => w.id === "wt-feature-x")!.path).toBe(wt.path);

    const project = (await (await authed(base, "/api/project?ws=wt-feature-x")).json()) as { path: string };
    expect(project.path).toBe(wt.path);

    // .git/info/exclude hides the checkouts; the base stays clean.
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".seekforge/worktrees/");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("derives a timestamp slug when no name is given and dedupes collisions", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);

    const first = await createWorktree(base);
    expect(first.id).toMatch(/^wt-\d{8}-\d{6}$/);

    const a = await createWorktree(base, "dup");
    const b = await createWorktree(base, "dup");
    expect(a.id).toBe("wt-dup");
    expect(b.id).toBe("wt-dup-2");
    expect(b.branch).toBe("seekforge/dup-2");
  });

  it("does not select the occupied terminal candidate after 100 slug conflicts", async () => {
    const repo = makeGitRepo();
    for (let candidateNumber = 1; candidateNumber <= 100; candidateNumber++) {
      const slug = candidateNumber === 1 ? "crowded" : `crowded-${candidateNumber}`;
      gitIn(repo, "branch", `seekforge/${slug}`);
    }
    const base = await boot(repo);

    const created = await createWorktree(base, "crowded");

    expect(created.id).toBe("wt-crowded-101");
    expect(created.branch).toBe("seekforge/crowded-101");
  });

  it("serializes concurrent creates of the same name (no TOCTOU 500)", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);

    // Fire two creates for the same name at once (a double-click): without
    // per-base serialization both would pick the same slug and the second
    // `git worktree add` would 500. Both must succeed with distinct slugs.
    const [a, b] = await Promise.all([createWorktree(base, "race"), createWorktree(base, "race")]);
    const ids = [a.id, b.id].sort();
    expect(ids).toEqual(["wt-race", "wt-race-2"]);
  });

  it("rejects non-git workspaces with not_a_git_repo", async () => {
    const base = await boot(makeWorkspace());
    const res = await authed(base, "/api/worktrees", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_a_git_repo");
  });

  it("rejects creation while the base workspace has an active session", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const lease = acquireSessionLease(repo, "running-create");
    try {
      const res = await authed(base, "/api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "blocked-create" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_busy");
    } finally {
      lease.release();
    }
    expect(existsSync(join(repo, ".seekforge", "worktrees", "blocked-create"))).toBe(false);
    expect(gitIn(repo, "branch", "--list", "seekforge/blocked-create")).toBe("");
  });
});

describe("GET /api/worktrees", () => {
  it("lists worktrees with dirty and ahead status", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "status");

    let list = (await (await authed(base, "/api/worktrees")).json()) as Array<{
      id: string;
      branch: string;
      dirty: boolean;
      ahead: number;
    }>;
    expect(list).toEqual([{ id: "wt-status", branch: "seekforge/status", path: wt.path, dirty: false, ahead: 0 }]);

    // Uncommitted work -> dirty; a commit -> ahead of the base HEAD.
    writeFileSync(join(wt.path, "new.txt"), "wip\n");
    list = (await (await authed(base, "/api/worktrees")).json()) as typeof list;
    expect(list[0]).toMatchObject({ dirty: true, ahead: 0 });

    gitIn(wt.path, "add", "-A");
    gitIn(wt.path, "commit", "-m", "work");
    list = (await (await authed(base, "/api/worktrees")).json()) as typeof list;
    expect(list[0]).toMatchObject({ dirty: false, ahead: 1 });
  });

  it("serializes list with concurrent worktree removal", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "list-remove-race");
    const [list, removal] = await Promise.all([
      authed(base, "/api/worktrees"),
      authed(base, `/api/worktrees/${wt.id}`, { method: "DELETE" }),
    ]);
    expect(list.status).toBe(200);
    expect(removal.status).toBe(200);
    const body = (await list.json()) as Array<{ id: string }>;
    expect(body.length === 0 || body.some((entry) => entry.id === wt.id)).toBe(true);
  });
});

describe("repository coordination", () => {
  it("uses one serialization domain for a base repo and its worktree", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "coordinator-key");
    const coordinator = new ServerCoordinator();
    let firstStarted = false;
    let secondStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = coordinator.withRepository(repo, async () => {
      firstStarted = true;
      await gate;
    });
    await waitUntil(() => firstStarted);
    const second = coordinator.withRepository(wt.path, async () => {
      secondStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondStarted).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});

describe("POST /api/worktrees/:id/merge", () => {
  it("full lifecycle: dirty work is auto-committed, merged into the base, then deleted", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "lifecycle");

    // Simulate an agent session writing a file in the worktree WORKSPACE
    // (left dirty on purpose — merge must checkpoint it first).
    writeFileSync(join(wt.path, "feature.txt"), "made in the worktree\n");

    const res = await authed(base, "/api/worktrees/wt-lifecycle/merge", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merged: true });

    // The file landed in the base checkout via a --no-ff merge of the
    // auto-checkpoint commit.
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("made in the worktree\n");
    const log = gitIn(repo, "log", "--format=%s");
    expect(log).toContain("seekforge worktree checkpoint");
    expect(log).toContain("merge seekforge/lifecycle (seekforge worktree)");

    // Delete: worktree dir + branch gone, workspace unregistered.
    const del = await authed(base, "/api/worktrees/wt-lifecycle", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(gitIn(repo, "branch", "--list", "seekforge/lifecycle")).toBe("");
    const workspaces = ((await (await authed(base, "/api/workspaces")).json()) as { workspaces: Array<{ id: string }> })
      .workspaces;
    expect(workspaces.map((w) => w.id)).not.toContain("wt-lifecycle");
    expect((await authed(base, "/api/sessions?ws=wt-lifecycle")).status).toBe(404);
  });

  it("merges already-committed worktree work without an extra checkpoint", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "clean");
    writeFileSync(join(wt.path, "clean.txt"), "committed\n");
    gitIn(wt.path, "add", "-A");
    gitIn(wt.path, "commit", "-m", "real commit");

    const res = await authed(base, "/api/worktrees/wt-clean/merge", { method: "POST" });
    expect(await res.json()).toEqual({ merged: true });
    expect(gitIn(repo, "log", "--format=%s")).not.toContain("seekforge worktree checkpoint");
    expect(readFileSync(join(repo, "clean.txt"), "utf8")).toBe("committed\n");
  });

  it("aborts conflicting merges and reports the files, leaving the base clean", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "conflict");

    // Both sides edit base.txt.
    writeFileSync(join(wt.path, "base.txt"), "worktree version\n");
    writeFileSync(join(repo, "base.txt"), "base version\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "diverge in base");

    const res = await authed(base, "/api/worktrees/wt-conflict/merge", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conflict: true, files: ["base.txt"] });

    // Never left mid-merge: no MERGE_HEAD, clean status, base content intact.
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("base version\n");

    // The worktree and its checkpoint survive for the user to resolve/retry.
    expect(readFileSync(join(wt.path, "base.txt"), "utf8")).toBe("worktree version\n");
  });

  it("404s on unknown worktree ids (merge and delete)", async () => {
    const base = await boot(makeGitRepo());
    expect((await authed(base, "/api/worktrees/wt-nope/merge", { method: "POST" })).status).toBe(404);
    expect((await authed(base, "/api/worktrees/wt-nope", { method: "DELETE" })).status).toBe(404);
  });

  it("rejects merge and removal while the worktree has an active session", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "busy-worktree");
    const lease = acquireSessionLease(wt.path, "running");
    try {
      for (const [path, method] of [
        [`/api/worktrees/${wt.id}/merge`, "POST"],
        [`/api/worktrees/${wt.id}`, "DELETE"],
      ] as const) {
        const res = await authed(base, path, { method });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_busy");
      }
    } finally {
      lease.release();
    }
    expect(existsSync(wt.path)).toBe(true);
  });

  it("rejects merge and removal while the base workspace has an active session", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const wt = await createWorktree(base, "busy-base");
    const lease = acquireSessionLease(repo, "running");
    try {
      expect((await authed(base, `/api/worktrees/${wt.id}/merge`, { method: "POST" })).status).toBe(409);
      expect((await authed(base, `/api/worktrees/${wt.id}`, { method: "DELETE" })).status).toBe(409);
    } finally {
      lease.release();
    }
    expect(existsSync(wt.path)).toBe(true);
  });

  it("serializes merges targeting the same base repository", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const first = await createWorktree(base, "merge-one");
    const second = await createWorktree(base, "merge-two");
    writeFileSync(join(first.path, "one.txt"), "one\n");
    writeFileSync(join(second.path, "two.txt"), "two\n");

    const responses = await Promise.all([
      authed(base, `/api/worktrees/${first.id}/merge`, { method: "POST" }),
      authed(base, `/api/worktrees/${second.id}/merge`, { method: "POST" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(readFileSync(join(repo, "one.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "two.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("serializes create with merge against the same base repository", async () => {
    const repo = makeGitRepo();
    const base = await boot(repo);
    const existing = await createWorktree(base, "merge-during-create");
    writeFileSync(join(existing.path, "merged.txt"), "merged\n");

    const [merge, create] = await Promise.all([
      authed(base, `/api/worktrees/${existing.id}/merge`, { method: "POST" }),
      authed(base, "/api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "created-during-merge" }),
      }),
    ]);
    expect([merge.status, create.status]).toEqual([200, 200]);
    expect(readFileSync(join(repo, "merged.txt"), "utf8")).toBe("merged\n");
    const created = (await create.json()) as { path: string };
    expect(existsSync(created.path)).toBe(true);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });
});
