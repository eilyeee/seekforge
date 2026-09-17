import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireWorkspaceSessionGuard, loadAgentDefinitions } from "@seekforge/core";
import { GLOBAL_CONFIG_LOCK_ID } from "@seekforge/shared/config-layers";
import { acquireSessionLease } from "@seekforge/core";
import { renderAgentDefinition, parseAgentDraft } from "../src/agent-definitions.js";
import { splitFilePatch } from "../src/routes/git.js";
import { parseTerminalFrame, terminalCommand } from "../src/terminal.js";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-desktop-surfaces";

let workspace: string;
let home: string;
let server: RunningServer;
let base: string;
const saved = { home: process.env.SEEKFORGE_HOME, shell: process.env.SHELL, path: process.env.PATH };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const TEN_LINES = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

beforeAll(async () => {
  workspace = makeWorkspace();
  home = mkdtempSync(join(tmpdir(), "seekforge-desktop-home-"));
  process.env.SEEKFORGE_HOME = home;
  process.env.SHELL = "/bin/sh";
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "t@example.com");
  git(workspace, "config", "user.name", "Tester");
  writeFileIn(workspace, "notes.txt", TEN_LINES);
  git(workspace, "add", "notes.txt");
  git(workspace, "commit", "-q", "-m", "init");
  writeFileIn(
    workspace,
    ".seekforge/sessions/s1/session.json",
    JSON.stringify({
      id: "s1",
      task: "original task",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    }),
  );
  writeFileIn(
    workspace,
    ".seekforge/sessions/s1/checkpoints.jsonl",
    `${JSON.stringify({ ts: "t", path: "src/a.ts", before: null, turn: 0 })}\n${JSON.stringify({ ts: "t", path: "notes.txt", before: "x", turn: 1 })}\n${JSON.stringify({ ts: "t", path: "src/a.ts", before: "y", turn: 1 })}\n`,
  );
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  for (const [key, value] of [
    ["SEEKFORGE_HOME", saved.home],
    ["SHELL", saved.shell],
    ["PATH", saved.path],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("per-hunk git actions", () => {
  const edit = () =>
    writeFileIn(
      workspace,
      "notes.txt",
      TEN_LINES.replace("line 2\n", "line two\n").replace("line 19\n", "line nineteen\n"),
    );

  it("splits a single-file patch into header and hunks", () => {
    const patch = splitFilePatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n");
    expect(patch).toEqual({
      header: ["diff --git a/x b/x", "--- a/x", "+++ b/x"],
      hunks: ["@@ -1 +1 @@\n-a\n+b", "@@ -9 +9 @@\n-c\n+d"],
    });
    expect(splitFilePatch("diff --git a/x b/x\ndiff --git a/y b/y\n")).toBeNull();
  });

  it("stages one hunk, unstages it again, and reverts one in the working tree", async () => {
    edit();
    const diff = await call("/api/diff");
    const hunks = splitFilePatch(diff.json.diff)!.hunks;
    expect(hunks).toHaveLength(2);

    const staged = await call("/api/git/hunk", {
      method: "POST",
      body: { path: "notes.txt", hunk: `${hunks[0]}\n`, action: "stage" },
    });
    expect(staged.status).toBe(200);
    const cached = git(workspace, "diff", "--cached");
    expect(cached).toContain("+line two");
    expect(cached).not.toContain("+line nineteen");

    const cachedHunk = splitFilePatch((await call("/api/diff?staged=1")).json.diff)!.hunks[0]!;
    const unstaged = await call("/api/git/hunk", {
      method: "POST",
      body: { path: "notes.txt", hunk: cachedHunk, action: "unstage" },
    });
    expect(unstaged.status).toBe(200);
    expect(git(workspace, "diff", "--cached")).toBe("");

    const reverted = await call("/api/git/hunk", {
      method: "POST",
      body: { path: "notes.txt", hunk: hunks[1], action: "revert" },
    });
    expect(reverted.status).toBe(200);
    const content = readFileSync(join(workspace, "notes.txt"), "utf8");
    expect(content).toContain("line two\n");
    expect(content).toContain("line 19\n");
    git(workspace, "checkout", "--", "notes.txt");
  });

  it("refuses a hunk that is no longer in the diff, and malformed requests", async () => {
    edit();
    const stale = await call("/api/git/hunk", {
      method: "POST",
      body: { path: "notes.txt", hunk: "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line deux\n line 3", action: "revert" },
    });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toContain("line two");

    for (const body of [
      { path: "", hunk: "@@ x", action: "stage" },
      { path: "notes.txt", hunk: "not a hunk", action: "stage" },
      { path: "notes.txt", hunk: "@@ -1 +1 @@", action: "force" },
    ]) {
      expect((await call("/api/git/hunk", { method: "POST", body })).status).toBe(400);
    }
    git(workspace, "checkout", "--", "notes.txt");
  });

  it("is refused while a session owns the workspace", async () => {
    edit();
    const hunk = splitFilePatch((await call("/api/diff")).json.diff)!.hunks[0];
    const guard = acquireWorkspaceSessionGuard(workspace);
    try {
      const busy = await call("/api/git/hunk", { method: "POST", body: { path: "notes.txt", hunk, action: "stage" } });
      expect(busy.status).toBe(409);
      expect(busy.json.error.code).toBe("session_busy");
    } finally {
      guard.release();
    }
    git(workspace, "checkout", "--", "notes.txt");
  });
});

describe("push and pull requests", () => {
  let remote: string;
  let branch: string;

  beforeAll(() => {
    remote = mkdtempSync(join(tmpdir(), "seekforge-remote-"));
    git(remote, "init", "-q", "--bare");
    git(workspace, "remote", "add", "origin", remote);
    branch = git(workspace, "symbolic-ref", "--short", "HEAD").trim();
  });

  it("reports branch, remotes and upstream", async () => {
    const info = await call("/api/git/remote");
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({ branch, remotes: ["origin"], upstream: null, ahead: null, behind: null });
    expect(typeof info.json.gh.available).toBe("boolean");
  });

  it("pushes the checked-out branch and sets its upstream", async () => {
    const pushed = await call("/api/git/push", {
      method: "POST",
      body: { remote: "origin", branch, setUpstream: true },
    });
    expect(pushed.status).toBe(200);
    expect(pushed.json).toMatchObject({ ok: true, remote: "origin", branch, destination: branch });
    expect(git(remote, "rev-parse", branch).trim()).toBe(git(workspace, "rev-parse", "HEAD").trim());
    const info = await call("/api/git/remote");
    expect(info.json).toMatchObject({ upstream: { remote: "origin", branch }, ahead: 0, behind: 0 });
  });

  it("refuses a stale branch name and an unknown remote", async () => {
    const stale = await call("/api/git/push", { method: "POST", body: { remote: "origin", branch: "other" } });
    expect(stale.status).toBe(409);
    const unknown = await call("/api/git/push", { method: "POST", body: { remote: "upstream", branch } });
    expect(unknown.status).toBe(400);
    expect((await call("/api/git/push", { method: "POST", body: { remote: "origin" } })).status).toBe(400);
  });

  it("never forces: a diverged remote is reported as a conflict and left intact", async () => {
    const other = mkdtempSync(join(tmpdir(), "seekforge-clone-"));
    git(other, "clone", "-q", remote, ".");
    git(other, "config", "user.email", "o@example.com");
    git(other, "config", "user.name", "Other");
    writeFileSync(join(other, "remote-only.txt"), "x\n");
    git(other, "add", "remote-only.txt");
    git(other, "commit", "-q", "-m", "remote");
    git(other, "push", "-q", "origin", branch);
    const remoteHead = git(remote, "rev-parse", branch).trim();

    writeFileIn(workspace, "local.txt", "y\n");
    git(workspace, "add", "local.txt");
    git(workspace, "commit", "-q", "-m", "local");
    const rejected = await call("/api/git/push", { method: "POST", body: { remote: "origin", branch } });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error.message).toContain("rejected");
    expect(git(remote, "rev-parse", branch).trim()).toBe(remoteHead);
  });

  it("explains a missing gh and relays a PR url from gh", async () => {
    const bin = mkdtempSync(join(tmpdir(), "seekforge-gh-"));
    process.env.PATH = `${bin}`;
    const missing = await call("/api/git/pr", { method: "POST", body: { title: "Add thing" } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.message).toContain("gh");

    const argsFile = join(bin, "args.txt");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argsFile}"\necho "Creating pull request"\necho "https://github.com/o/r/pull/7"\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const created = await call("/api/git/pr", {
      method: "POST",
      body: { title: "-Add thing", body: "--why", draft: true, base: "main" },
    });
    process.env.PATH = saved.path;
    expect(created.status).toBe(200);
    expect(created.json.url).toBe("https://github.com/o/r/pull/7");
    expect(readFileSync(argsFile, "utf8").split("\n")).toEqual([
      "pr",
      "create",
      "--title=-Add thing",
      "--body=--why",
      "--draft",
      "--base=main",
      "",
    ]);
    expect((await call("/api/git/pr", { method: "POST", body: { title: "" } })).status).toBe(400);
    expect((await call("/api/git/pr", { method: "POST", body: { title: "t", base: "-x" } })).status).toBe(400);
  });
});

describe("cancellation of long git/gh processes", () => {
  it("ends gh when the client disconnects instead of letting it run on", async () => {
    const bin = mkdtempSync(join(tmpdir(), "seekforge-slow-gh-"));
    const marker = join(bin, "finished");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nsleep 2\necho done > "${marker}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${saved.path}`;
    try {
      const controller = new AbortController();
      const pending = fetch(`${base}/api/git/pr`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "slow" }),
        signal: controller.signal,
      }).catch((error: unknown) => error);
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 2_500));
      // The shell that would have written the marker was terminated.
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = saved.path;
    }
  }, 15_000);
});

describe("session names and changes", () => {
  it("renames a session, shows the name in list and detail, and clears it", async () => {
    const renamed = await call("/api/sessions/s1", { method: "PATCH", body: { name: "  Fix   the parser " } });
    expect(renamed).toEqual({ status: 200, json: { id: "s1", name: "Fix the parser" } });
    const list = await call("/api/sessions");
    expect(list.json.find((s: { id: string }) => s.id === "s1").name).toBe("Fix the parser");
    expect((await call("/api/sessions/s1")).json.meta.name).toBe("Fix the parser");

    const cleared = await call("/api/sessions/s1", { method: "PATCH", body: { name: "" } });
    expect(cleared.json.name).toBeNull();
    expect((await call("/api/sessions")).json.find((s: { id: string }) => s.id === "s1").name).toBeUndefined();

    expect((await call("/api/sessions/nope", { method: "PATCH", body: { name: "x" } })).status).toBe(404);
    expect((await call("/api/sessions/s1", { method: "PATCH", body: { name: 7 } })).status).toBe(400);
  });

  it("lists the files a session changed, once each", async () => {
    expect((await call("/api/sessions/s1/changes")).json).toEqual({ files: ["src/a.ts", "notes.txt"] });
    expect((await call("/api/sessions/missing/changes")).status).toBe(404);
  });
});

describe("permission rules editor", () => {
  it("adds, edits and deletes rules per scope with a stale-edit guard", async () => {
    const added = await call("/api/permission-rules", {
      method: "POST",
      body: { scope: "user", rule: { action: "allow", tool: "run_command", match: " pnpm test " } },
    });
    expect(added.status).toBe(200);
    expect(added.json.user).toEqual([
      {
        index: 0,
        raw: { action: "allow", tool: "run_command", match: "pnpm test" },
        rule: expect.any(Object),
        effective: true,
      },
    ]);
    const stored = JSON.parse(readFileSync(join(home, ".seekforge", "config.json"), "utf8"));
    expect(stored.permissionRules).toEqual([{ action: "allow", tool: "run_command", match: "pnpm test" }]);

    const projectAllow = await call("/api/permission-rules", {
      method: "POST",
      body: { scope: "project", rule: { action: "allow", tool: "write_file" } },
    });
    expect(projectAllow.status).toBe(400);
    expect(projectAllow.json.error.message).toContain("deny or ask");

    const projectAsk = await call("/api/permission-rules", {
      method: "POST",
      body: { scope: "project", rule: { action: "ask", tool: "read_file", match: "secrets/" } },
    });
    expect(projectAsk.json.project).toHaveLength(1);

    const stale = await call("/api/permission-rules", {
      method: "PUT",
      body: { scope: "user", index: 0, expected: { action: "deny", tool: "x" }, rule: { action: "deny", tool: "x" } },
    });
    expect(stale.status).toBe(409);

    const edited = await call("/api/permission-rules", {
      method: "PUT",
      body: {
        scope: "user",
        index: 0,
        // Same entry, different key order: still the entry the editor saw.
        expected: { match: "pnpm test", tool: "run_command", action: "allow" },
        rule: { action: "deny", tool: "run_command", match: "rm" },
      },
    });
    expect(edited.json.user[0].raw).toEqual({ action: "deny", tool: "run_command", match: "rm" });

    const removed = await call("/api/permission-rules", {
      method: "DELETE",
      body: { scope: "user", index: 0, expected: edited.json.user[0].raw },
    });
    expect(removed.json.user).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, ".seekforge", "config.json"), "utf8")).permissionRules).toBeUndefined();

    for (const body of [
      { scope: "team", rule: { action: "deny", tool: "x" } },
      { scope: "user", rule: { action: "maybe", tool: "x" } },
      { scope: "user", rule: { action: "deny", tool: " " } },
      { scope: "user", rule: { action: "deny", tool: "x", extra: 1 } },
      { scope: "user", index: -1, expected: null, rule: { action: "deny", tool: "x" } },
    ]) {
      const method = "index" in body ? "PUT" : "POST";
      expect((await call("/api/permission-rules", { method, body })).status).toBe(400);
    }
  });

  it("keeps entries it cannot parse and marks ignored project allow rules", async () => {
    writeFileIn(
      workspace,
      ".seekforge/config.json",
      `${JSON.stringify({ model: "m", permissionRules: [{ action: "allow", tool: "write_file" }, "junk", { action: "deny", tool: "web_fetch" }] })}\n`,
    );
    const listed = await call("/api/permission-rules");
    expect(listed.json.project.map((entry: { effective: boolean }) => entry.effective)).toEqual([false, false, true]);
    expect(listed.json.project[1].rule).toBeUndefined();
    const removed = await call("/api/permission-rules", {
      method: "DELETE",
      body: { scope: "project", index: 2, expected: { action: "deny", tool: "web_fetch" } },
    });
    expect(removed.status).toBe(200);
    const stored = JSON.parse(readFileSync(join(workspace, ".seekforge", "config.json"), "utf8"));
    expect(stored).toEqual({ model: "m", permissionRules: [{ action: "allow", tool: "write_file" }, "junk"] });
  });

  it("serializes user edits with every other global-config writer", async () => {
    const lease = acquireSessionLease(realpathSync(home), GLOBAL_CONFIG_LOCK_ID);
    try {
      const busy = await call("/api/permission-rules", {
        method: "POST",
        body: { scope: "user", rule: { action: "deny", tool: "x" } },
      });
      expect(busy.status).toBe(400);
      expect(busy.json.error.message).toContain("another SeekForge process");
      const settings = await call("/api/config", {
        method: "PUT",
        body: { key: "sandbox", value: "off", global: true },
      });
      expect(settings.status).toBe(409);
    } finally {
      lease.release();
    }
  });
});

describe("agent definition editor", () => {
  const draft = {
    name: "Reviewer",
    description: "Reviews diffs",
    tools: ["read_file", "search_text"],
    mode: "ask",
    model: "",
    maxTurns: 8,
    body: "Be terse.",
    extra: [],
  };

  it("creates a project agent the core loader reads back", async () => {
    const created = await call("/api/agents", {
      method: "POST",
      body: { id: "reviewer-x", scope: "project", ...draft },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ id: "reviewer-x", scope: "project", name: "Reviewer", maxTurns: 8 });
    const def = loadAgentDefinitions(workspace).find((d) => d.id === "reviewer-x");
    expect(def).toMatchObject({ scope: "project", mode: "ask", tools: ["read_file", "search_text"], maxTurns: 8 });
    expect(def?.body).toBe("Be terse.");

    const again = await call("/api/agents", { method: "POST", body: { id: "reviewer-x", scope: "project", ...draft } });
    expect(again.status).toBe(409);
  });

  it("round-trips frontmatter keys the form does not own", async () => {
    const file = join(workspace, ".seekforge", "agents", "keeper", "AGENT.md");
    mkdirSync(join(workspace, ".seekforge", "agents", "keeper"), { recursive: true });
    writeFileSync(
      file,
      [
        "---",
        "# hand-written",
        "name: Keeper",
        "color: blue",
        "skills:",
        "  - lint",
        "  - test",
        'trigger: "review | audit"',
        "mode: edit",
        "---",
        "",
        "Original body.",
        "",
      ].join("\n"),
    );
    const source = await call("/api/agents/keeper/source");
    expect(source.status).toBe(200);
    expect(source.json).toMatchObject({ id: "keeper", scope: "project", name: "Keeper", tools: null, mode: "edit" });
    expect(source.json.extra).toEqual([
      { key: "color", value: "blue" },
      { key: "skills", value: "\n  - lint\n  - test" },
      { key: "trigger", value: '"review | audit"' },
    ]);

    const extra = source.json.extra.filter((field: { key: string }) => field.key !== "color");
    extra.push({ key: "effort", value: "high" });
    const updated = await call("/api/agents/keeper", {
      method: "PUT",
      body: { ...source.json, scope: "project", description: "Keeps things", extra },
    });
    expect(updated.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(
      [
        "---",
        "# hand-written",
        'name: "Keeper"',
        "skills:",
        "  - lint",
        "  - test",
        'trigger: "review | audit"',
        'mode: "edit"',
        'description: "Keeps things"',
        "effort: high",
        "---",
        "",
        "Original body.",
        "",
      ].join("\n"),
    );
    expect(loadAgentDefinitions(workspace).find((d) => d.id === "keeper")?.triggers).toEqual(["review", "audit"]);
  });

  it("writes global agents under the SeekForge home and refuses what would not load", async () => {
    const created = await call("/api/agents", { method: "POST", body: { id: "helper", scope: "global", ...draft } });
    expect(created.status).toBe(201);
    expect(readFileSync(join(home, ".seekforge", "agents", "helper", "AGENT.md"), "utf8")).toContain(
      'name: "Reviewer"',
    );

    const cases: Array<[string, Record<string, unknown>]> = [
      ["/api/agents", { id: "../escape", scope: "project", ...draft }],
      ["/api/agents", { id: "Upper", scope: "project", ...draft }],
      ["/api/agents", { id: "ok-id", scope: "elsewhere", ...draft }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, mode: "yolo" }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, maxTurns: 0 }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, tools: ["a,b"] }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, extra: [{ key: "mode", value: "ask" }] }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, extra: [{ key: "x", value: "a\nmode: edit" }] }],
      ["/api/agents", { id: "ok-id", scope: "project", ...draft, extra: [{ key: "x", value: "a\n---" }] }],
    ];
    for (const [path, body] of cases) {
      expect((await call(path, { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("/api/agents/ghost", { method: "PUT", body: { scope: "project", ...draft } })).status).toBe(404);
    expect((await call("/api/agents/ghost/source")).status).toBe(404);
    expect((await call("/api/agents/reviewer-x/source?scope=nowhere")).status).toBe(400);
  });

  it("does not open builtin agents for editing", async () => {
    const builtin = loadAgentDefinitions(workspace).find((d) => d.scope === "builtin");
    expect(builtin).toBeDefined();
    const res = await call(`/api/agents/${builtin!.id}/source`);
    expect(res.status).toBe(400);
  });

  it("renders a fresh definition with only the keys that are set", () => {
    const rendered = renderAgentDefinition(
      parseAgentDraft({ ...draft, name: "", tools: null, maxTurns: null, body: "" }),
    );
    expect(rendered).toBe('---\ndescription: "Reviews diffs"\nmode: "ask"\n---\n');
  });
});

describe("hooks editor tolerance", () => {
  it("keeps fields and stored stages it does not know, and still refuses a new unknown stage", async () => {
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    const configPath = join(home, ".seekforge", "config.json");
    const current = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...current, hooks: { futureStage: [{ command: "echo later" }] } }));
    const hooks = {
      futureStage: [{ command: "echo later", timeout: 5 }],
      postToolUse: [{ type: "http", url: "http://127.0.0.1:9/hook", match: "" }],
      stop: [{ type: "prompt", prompt: "Summarize", command: "true" }],
    };
    const put = await call("/api/hooks", { method: "PUT", body: { hooks } });
    expect(put.status).toBe(200);
    expect(put.json.hooks).toEqual({
      futureStage: [{ command: "echo later", timeout: 5 }],
      postToolUse: [{ type: "http", url: "http://127.0.0.1:9/hook" }],
      stop: [{ type: "prompt", prompt: "Summarize", command: "true" }],
    });
    expect((await call("/api/hooks")).json.hooks).toEqual(put.json.hooks);

    for (const bad of [
      { brandNewStage: [{ command: "x" }] },
      { stop: [{ match: "x" }] },
      { stop: [{ command: "x", __proto__x: 1 }] },
      { stop: [{ type: "" }] },
    ]) {
      expect((await call("/api/hooks", { method: "PUT", body: { hooks: bad } })).status).toBe(400);
    }
  });
});

describe("workspace terminal", () => {
  it("parses only well-formed frames and builds a PTY launch line", () => {
    expect(parseTerminalFrame('{"type":"input","data":"ls\\r"}')).toEqual({ type: "input", data: "ls\r" });
    expect(parseTerminalFrame('{"type":"resize","cols":80,"rows":24}')).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(parseTerminalFrame('{"type":"resize","cols":1,"rows":24}')).toHaveProperty("error");
    expect(parseTerminalFrame('{"type":"input","data":1}')).toHaveProperty("error");
    expect(parseTerminalFrame('{"type":"exec"}')).toHaveProperty("error");
    expect(parseTerminalFrame("nope")).toHaveProperty("error");

    const mac = terminalCommand("/bin/zsh", "darwin", true, { cols: 90, rows: 20 });
    expect(mac.args[1]).toContain("script -q /dev/null");
    expect(mac.env).toMatchObject({ SF_SHELL: "/bin/zsh", SF_COLS: "90", SF_ROWS: "20" });
    expect(mac.env.SF_INNER).toContain('"$s" -l -i');
    const linux = terminalCommand("/bin/sh", "linux", true, { cols: 90, rows: 20 });
    expect(linux.args[1]).toContain("script -qfc");
    expect(linux.env.SF_INNER).toContain('"$s" -i');
    expect(terminalCommand("/bin/sh", "linux", false, { cols: 90, rows: 20 }).args[1]).not.toContain("script");
  });

  it("reports availability", async () => {
    const res = await call("/api/terminal");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ available: process.platform !== "win32", cwd: workspace });
  });

  it("runs a shell in the workspace and kills it when the socket closes", async () => {
    // A dedicated server: close() drains every tracked terminal exit, so it
    // only resolves promptly if closing the socket really ended the shell.
    const own = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
    const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws/terminal?token=${TOKEN}&cols=80&rows=24`);
    const frames: Array<{ type: string; data?: string }> = [];
    let output = "";
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type: string; data?: string };
      frames.push(frame);
      if (frame.type === "output") output += frame.data;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const deadline = Date.now() + 10_000;
    while (!frames.some((f) => f.type === "ready") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    const marker = join(mkdtempSync(join(tmpdir(), "seekforge-term-")), "hangup");
    ws.send(JSON.stringify({ type: "input", data: `trap 'echo gone > ${marker}; exit 0' HUP\r` }));
    ws.send(JSON.stringify({ type: "input", data: "echo sf-$((20+22)); pwd\r" }));
    ws.send("not json");
    while (!output.includes("sf-42") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(output).toContain("sf-42");
    expect(output).toContain(realpathSync(workspace).split("/").pop());
    expect(output).not.toContain("SeekForgeTty");
    expect(frames.some((f) => f.type === "error")).toBe(true);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    // The shell itself received the hangup: closing the socket ended it.
    const hangupDeadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < hangupDeadline) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(marker)).toBe(true);
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("refuses unauthenticated and disabled terminals", async () => {
    const unauthorized = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/terminal`);
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => resolve(101));
    });
    expect(unauthorized).toBe(401);

    const disabled = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      createAgent: unusedAgentFactory,
      terminal: false,
    });
    try {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${disabled.port}/ws/terminal?token=${TOKEN}`);
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => resolve(101));
      });
      expect(status).toBe(403);
      const res = await fetch(`http://127.0.0.1:${disabled.port}/api/terminal`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await res.json()).toMatchObject({ available: false });
    } finally {
      await disabled.close();
    }
  });
});
