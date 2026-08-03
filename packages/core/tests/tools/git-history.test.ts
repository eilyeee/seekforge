import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx } from "./helpers.js";

/**
 * git_log / git_blame / git_show against a real repository — the parsing is the
 * whole point of these tools, so a fake would test nothing. Two commits by two
 * authors give every field something to be wrong about.
 */

const dispatcher = createDefaultDispatcher();
let workspace: string;

/** Deterministic identity and dates, so assertions are exact. */
function git(args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, {
    cwd: workspace,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.com",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
      ...env,
    },
    stdio: "ignore",
  });
}

beforeEach(() => {
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-git-")));
  git(["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(workspace, "app.ts"), "const a = 1;\nconst b = 2;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "feat: first commit"]);

  fs.writeFileSync(path.join(workspace, "app.ts"), "const a = 1;\nconst b = 22;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "fix: correct b"], {
    GIT_AUTHOR_NAME: "Grace Hopper",
    GIT_AUTHOR_EMAIL: "grace@example.com",
    GIT_AUTHOR_DATE: "2026-02-03T04:05:06+00:00",
    GIT_COMMITTER_DATE: "2026-02-03T04:05:06+00:00",
  });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const run = (name: string, args: unknown) => dispatcher.execute(call(name, args), makeCtx(workspace));

describe("git_log", () => {
  it("returns commits newest first, with locale-independent dates", async () => {
    const res = await run("git_log", {});
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const data = res.data as { commits: Array<{ author: string; date: string; subject: string }>; count: number };
    expect(data.count).toBe(2);
    expect(data.commits[0]).toMatchObject({
      author: "Grace Hopper",
      subject: "fix: correct b",
      date: "2026-02-03T04:05:06+00:00",
    });
    expect(data.commits[1]).toMatchObject({ author: "Ada Lovelace", subject: "feat: first commit" });
  });

  it("narrows by author and by path", async () => {
    fs.writeFileSync(path.join(workspace, "other.ts"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-m", "chore: unrelated file"]);

    const byAuthor = (await run("git_log", { author: "Grace" })).data as { commits: Array<{ subject: string }> };
    expect(byAuthor.commits.map((c) => c.subject)).toEqual(["fix: correct b"]);

    const byPath = (await run("git_log", { path: "other.ts" })).data as { commits: Array<{ subject: string }> };
    expect(byPath.commits.map((c) => c.subject)).toEqual(["chore: unrelated file"]);
  });

  it("honours the limit", async () => {
    const data = (await run("git_log", { limit: 1 })).data as { count: number };
    expect(data.count).toBe(1);
  });

  it("refuses an author that would be read as an option", async () => {
    const res = await run("git_log", { author: "--output=/tmp/pwned" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("refuses a path outside the workspace", async () => {
    const res = await run("git_log", { path: "../escape" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
  });
});

describe("git_blame", () => {
  it("attributes each line to the commit that last touched it", async () => {
    const res = await run("git_blame", { path: "app.ts" });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const data = res.data as {
      lines: Array<{ line: number; author: string; summary: string; text: string; date: string }>;
    };
    expect(data.lines).toHaveLength(2);
    expect(data.lines[0]).toMatchObject({
      line: 1,
      author: "Ada Lovelace",
      summary: "feat: first commit",
      text: "const a = 1;",
    });
    expect(data.lines[1]).toMatchObject({ line: 2, author: "Grace Hopper", summary: "fix: correct b" });
    expect(data.lines[1]?.date).toBe("2026-02-03T04:05:06.000Z");
  });

  it("annotates only the requested range", async () => {
    const data = (await run("git_blame", { path: "app.ts", line: 2 })).data as { lines: Array<{ line: number }> };
    expect(data.lines.map((l) => l.line)).toEqual([2]);
  });

  it("refuses an unreasonably large range rather than dumping a file", async () => {
    const res = await run("git_blame", { path: "app.ts", line: 1, endLine: 5000 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });
});

describe("git_show", () => {
  it("shows a commit's message and diff", async () => {
    const log = (await run("git_log", { limit: 1 })).data as { commits: Array<{ hash: string }> };
    const res = await run("git_show", { ref: log.commits[0]!.hash });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const output = (res.data as { output: string }).output;
    expect(output).toContain("fix: correct b");
    expect(output).toContain("-const b = 2;");
    expect(output).toContain("+const b = 22;");
  });

  it("reduces to a file summary with statOnly", async () => {
    const output = ((await run("git_show", { ref: "HEAD", statOnly: true })).data as { output: string }).output;
    expect(output).toContain("app.ts");
    expect(output).not.toContain("+const b = 22;");
  });

  it("refuses a ref that would be read as an option", async () => {
    const res = await run("git_show", { ref: "--help" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  it("reports a ref that does not exist", async () => {
    const res = await run("git_show", { ref: "deadbeef" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("git_error");
  });
});

describe("history tools are readonly", () => {
  it.each(["git_log", "git_blame", "git_show"])("%s never reaches the permission prompt", async (name) => {
    const args = name === "git_blame" ? { path: "app.ts" } : name === "git_show" ? { ref: "HEAD" } : {};
    const res = await dispatcher.execute(
      call(name, args),
      makeCtx(workspace, {
        policy: { approvalMode: "manual", mode: "ask" },
        confirm: async () => {
          throw new Error(`${name} must not prompt`);
        },
      }),
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.meta?.permission).toBe("readonly");
  });
});
