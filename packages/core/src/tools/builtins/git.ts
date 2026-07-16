import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { truncateHeadTail } from "../text.js";
import { callRuntime } from "../runtime-backend.js";
import { defineTool, type ToolSpec } from "../registry.js";

const execFileAsync = promisify(execFile);

/** Force English git messages so error-detection regexes work on any locale. */
const GIT_ENV = { ...process.env, LC_ALL: "C" };

/** Run git directly (no shell) inside the workspace. */
async function runGit(workspace: string, args: string[]): Promise<{ text: string; truncated: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 10_000_000,
      timeout: 30_000,
    });
    return truncateHeadTail(stdout, DEFAULT_LIMITS.toolOutputMaxChars);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new ToolError("git_error", `git ${args.join(" ")} failed`, {
      stderr: (e.stderr ?? e.message ?? "").slice(0, 2000),
    });
  }
}

const gitStatus = defineTool({
  name: "git_status",
  description:
    "Show the working tree status (git status --porcelain=v1 -b). Run it after editing to verify exactly which files you touched before committing or reporting results.",
  schema: z.object({}),
  classify: () => ({
    permission: "readonly",
    description: "Run git status",
    command: "git status --porcelain=v1 -b",
  }),
  async run(_args, ctx) {
    if (ctx.runtime) {
      const res = await callRuntime<{ output: string }>(ctx.runtime, "git_status", ctx.workspace, {});
      return { data: { status: res.output } };
    }
    const { text, truncated } = await runGit(ctx.workspace, ["status", "--porcelain=v1", "-b"]);
    return { data: { status: text }, meta: { truncated } };
  },
});

const gitDiffSchema = z.object({
  staged: z.boolean().optional().describe("Show staged changes (git diff --cached) instead of unstaged."),
});

const gitDiff = defineTool({
  name: "git_diff",
  description:
    "Show uncommitted changes (git diff, or git diff --cached when staged is true). Use it to review your own edits before committing or reporting — the diff is the ground truth of what actually changed.",
  schema: gitDiffSchema,
  classify: (args) => ({
    permission: "readonly",
    description: "Run git diff",
    command: args.staged ? "git diff --cached" : "git diff",
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      const res = await callRuntime<{ output: string }>(ctx.runtime, "git_diff", ctx.workspace, {
        staged: args.staged ?? false,
      });
      return { data: { diff: res.output } };
    }
    const gitArgs = args.staged ? ["diff", "--cached"] : ["diff"];
    const { text, truncated } = await runGit(ctx.workspace, gitArgs);
    return { data: { diff: text }, meta: { truncated } };
  },
});

const gitCommitSchema = z.object({
  message: z.string().min(1).describe("Commit message (conventional commits preferred)."),
  addAll: z.boolean().optional().describe("Stage all changes first with `git add -A` (default true)."),
});

const gitCommit = defineTool({
  name: "git_commit",
  description:
    "Create a git commit with message (stages ALL changes first by default; set addAll:false to commit only what is already staged). Check git_status/git_diff first so you know what goes in. Pushing is separate: a `git push` via run_command always requires explicit human approval (force-push stays denied).",
  schema: gitCommitSchema,
  classify: (args) => ({
    permission: "write",
    description: `Create git commit: ${args.message.split("\n")[0]}`,
    command: `git commit -m ${JSON.stringify(args.message.split("\n")[0])}`,
  }),
  async run(args, ctx) {
    if (args.addAll !== false) {
      try {
        await execFileAsync("git", ["add", "-A"], { cwd: ctx.workspace, timeout: 30_000, env: GIT_ENV });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ToolError("git_error", "git add -A failed", {
          stderr: (e.stderr ?? e.message ?? "").slice(0, 2000),
        });
      }
    }
    try {
      await execFileAsync("git", ["commit", "-m", args.message], {
        cwd: ctx.workspace,
        timeout: 30_000,
        env: GIT_ENV,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (/nothing (added )?to commit/i.test(out)) {
        throw new ToolError("nothing_to_commit", "Nothing to commit — the working tree is clean.");
      }
      throw new ToolError("git_error", "git commit failed", { stderr: out.slice(0, 2000) });
    }
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ctx.workspace,
      timeout: 10_000,
    });
    return { data: { commit: stdout.trim(), message: args.message } };
  },
});

export const gitTools: ToolSpec[] = [gitStatus, gitDiff, gitCommit];
