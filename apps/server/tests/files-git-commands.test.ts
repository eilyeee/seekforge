import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-fgc";

let workspace: string;
let server: RunningServer;
let base: string;
let home: string;
const savedHome = process.env.SEEKFORGE_HOME;

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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd });
}

beforeAll(async () => {
  workspace = makeWorkspace();
  home = mkdtempSync(join(tmpdir(), "seekforge-fgc-home-"));
  process.env.SEEKFORGE_HOME = home;

  // A git repo with a committed file, a staged add, an unstaged modification,
  // and an untracked file.
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "t@example.com");
  git(workspace, "config", "user.name", "Tester");
  writeFileIn(workspace, "src/app.ts", "export const x = 1;\n");
  writeFileIn(workspace, "README.md", "hello\n");
  // A binary file and a sensitive file to test rejection.
  writeFileSync(join(workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(join(workspace, ".env"), "SECRET=abc\n");
  git(workspace, "add", "src/app.ts", "README.md");
  git(workspace, "commit", "-q", "-m", "init");

  // Now create the working-tree states.
  writeFileIn(workspace, "src/app.ts", "export const x = 2;\n"); // unstaged modify
  writeFileIn(workspace, "src/new.ts", "export const y = 3;\n"); // untracked
  git(workspace, "add", "src/new.ts"); // staged add

  // Project + user custom commands.
  writeFileIn(workspace, ".seekforge/commands/review.md", "Review the diff\nbody line\n");
  mkdirSync(join(home, ".seekforge", "commands"), { recursive: true });
  writeFileSync(join(home, ".seekforge", "commands", "ship.md"), "Ship it\n");

  // A session for the compact endpoint.
  writeFileIn(
    workspace,
    ".seekforge/sessions/sx/session.json",
    JSON.stringify({
      id: "sx",
      task: "t",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
  );

  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = savedHome;
});

describe("GET /api/tree", () => {
  it("lists the workspace root, dirs first then files, hiding .git/.env", async () => {
    const res = await authed("/api/tree");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.path).toBe("");
    const names = body.entries.map((e: { name: string }) => e.name);
    // src (dir) comes before files; .git, .seekforge (dot-dir), .env are hidden.
    expect(names).toContain("src");
    expect(names).not.toContain(".git");
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".seekforge");
    const dirIdx = body.entries.findIndex((e: { type: string }) => e.type === "dir");
    const fileIdx = body.entries.findIndex((e: { type: string }) => e.type === "file");
    expect(dirIdx).toBeLessThan(fileIdx);
    const src = body.entries.find((e: { name: string }) => e.name === "src");
    expect(src).toMatchObject({ type: "dir", path: "src" });
  });

  it("lists a subdirectory by ?path", async () => {
    const res = await authed("/api/tree?path=src");
    const body = await jsonOf(res);
    expect(body.path).toBe("src");
    expect(body.entries.map((e: { path: string }) => e.path).sort()).toEqual(["src/app.ts", "src/new.ts"]);
  });

  it("rejects a traversal path with 400", async () => {
    const res = await authed("/api/tree?path=../etc");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/file", () => {
  it("reads a text file", async () => {
    const res = await authed("/api/file?path=src/app.ts");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toEqual({ path: "src/app.ts", content: "export const x = 2;\n", truncated: false });
  });

  it("rejects a binary file with 400", async () => {
    const res = await authed("/api/file?path=logo.png");
    expect(res.status).toBe(400);
  });

  it("rejects a denylisted (.env) file with 400", async () => {
    const res = await authed("/api/file?path=.env");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/file", () => {
  it("writes a file and creates parent dirs", async () => {
    const res = await authed("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "docs/notes/todo.md", content: "# todo\n" }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ok: true });
    expect(readFileSync(join(workspace, "docs/notes/todo.md"), "utf8")).toBe("# todo\n");
  });

  it("rejects writing a denylisted file with 400", async () => {
    const res = await authed("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".env", content: "X=1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects writing outside the workspace with 400", async () => {
    const res = await authed("/api/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../escape.txt", content: "no" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(workspace, "..", "escape.txt"))).toBe(false);
  });
});

describe("GET /api/git/status", () => {
  it("reports branch and staged/unstaged/untracked files", async () => {
    const res = await authed("/api/git/status");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.notGit).toBeUndefined();
    expect(typeof body.branch).toBe("string");
    const byPath = new Map<string, { status: string; staged: boolean }[]>();
    for (const f of body.files) {
      byPath.set(f.path, [...(byPath.get(f.path) ?? []), { status: f.status, staged: f.staged }]);
    }
    expect(byPath.get("src/app.ts")).toContainEqual({ status: "modified", staged: false });
    expect(byPath.get("src/new.ts")).toContainEqual({ status: "added", staged: true });
  });
});

describe("git stage / unstage / commit", () => {
  it("stages, then commits the staged changes", async () => {
    const stage = await authed("/api/git/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["src/app.ts"] }),
    });
    expect(stage.status).toBe(200);
    expect(await jsonOf(stage)).toEqual({ ok: true });

    const commit = await authed("/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "feat: change" }),
    });
    expect(commit.status).toBe(200);
    const body = await jsonOf(commit);
    expect(body.ok).toBe(true);
    expect(body.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("commit with empty message is 400", async () => {
    const res = await authed("/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("commit with nothing staged is 400", async () => {
    // After the prior commit, src/app.ts and new.ts are committed; only an
    // untracked README change could remain. Ensure clean index → nothing staged.
    const res = await authed("/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "noop" }),
    });
    expect(res.status).toBe(400);
  });

  it("unstage moves a staged file back to unstaged", async () => {
    writeFileIn(workspace, "src/app.ts", "export const x = 99;\n");
    await authed("/api/git/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["src/app.ts"] }),
    });
    const unstage = await authed("/api/git/unstage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["src/app.ts"] }),
    });
    expect(unstage.status).toBe(200);
    const status = await jsonOf(await authed("/api/git/status"));
    const entry = status.files.find(
      (f: { path: string; staged: boolean }) => f.path === "src/app.ts" && f.staged,
    );
    expect(entry).toBeUndefined();
  });
});

describe("git discard", () => {
  it("discards a tracked modification and removes an untracked file", async () => {
    writeFileIn(workspace, "src/app.ts", "garbage\n");
    writeFileIn(workspace, "trash.txt", "junk\n");
    const res = await authed("/api/git/discard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["src/app.ts", "trash.txt"] }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(workspace, "trash.txt"))).toBe(false);
    expect(readFileSync(join(workspace, "src/app.ts"), "utf8")).not.toBe("garbage\n");
  });
});

describe("git on a non-repo", () => {
  it("returns notGit instead of throwing", async () => {
    const plain = makeWorkspace();
    const s = await startServer({ workspace: plain, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    try {
      const b = `http://127.0.0.1:${s.port}`;
      const res = await fetch(`${b}/api/git/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ notGit: true, branch: "", files: [] });
    } finally {
      await s.close();
    }
  });
});

describe("GET /api/commands", () => {
  it("lists project and user commands (project wins on clash)", async () => {
    const res = await authed("/api/commands");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const names = body.commands.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["review", "ship"]);
    expect(body.commands.find((c: { name: string }) => c.name === "review")).toMatchObject({
      scope: "project",
      description: "Review the diff",
    });
    expect(body.commands.find((c: { name: string }) => c.name === "ship").scope).toBe("user");
  });
});

describe("hooks editor (GET/PUT /api/hooks)", () => {
  it("writes hooks to the project config and reads them back; rejects bad input", async () => {
    const put = await authed("/api/hooks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hooks: { preToolUse: [{ command: "echo hi", match: "run_command" }] },
      }),
    });
    expect(put.status).toBe(200);
    const get = await authed("/api/hooks");
    const body = await jsonOf(get);
    expect(body.hooks.preToolUse).toEqual([{ command: "echo hi", match: "run_command" }]);

    const bad = await authed("/api/hooks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hooks: { bogusStage: [{ command: "x" }] } }),
    });
    expect(bad.status).toBe(400);

    // A JSON `null` body must be a clean 400, not a 500.
    const nullBody = await authed("/api/hooks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(nullBody.status).toBe(400);
  });
});

describe("GET /api/output-styles", () => {
  it("lists the built-ins plus custom .seekforge/output-styles files", async () => {
    writeFileIn(workspace, ".seekforge/output-styles/pirate.md", "Arr");
    const res = await authed("/api/output-styles");
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const names = body.styles.map((s: { name: string }) => s.name);
    expect(names.slice(0, 4)).toEqual(["default", "concise", "explanatory", "learning"]);
    expect(body.styles.find((s: { name: string }) => s.name === "pirate")).toMatchObject({
      kind: "custom",
    });
  });
});

describe("POST /api/commands/expand", () => {
  it("interpolates args and runs !`shell` injections in the workspace", async () => {
    writeFileIn(workspace, ".seekforge/commands/exp.md", "task: $ARGUMENTS; out: !`echo hi`");
    const res = await authed("/api/commands/expand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "exp", args: "do it" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.text).toBe("task: do it; out: hi");
  });

  it("404 for an unknown command", async () => {
    const res = await authed("/api/commands/expand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nope", args: "" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/compact", () => {
  it("404 for a missing session", async () => {
    const res = await authed("/api/sessions/nope/compact", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns the compaction result (null when too short)", async () => {
    const res = await authed("/api/sessions/sx/compact", { method: "POST" });
    expect(res.status).toBe(200);
    // sx has no messages → compactSessionNow returns null.
    expect(await jsonOf(res)).toBeNull();
  });
});
