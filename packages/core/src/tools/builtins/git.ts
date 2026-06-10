import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { truncateHeadTail } from "../text.js";
import { defineTool, type ToolSpec } from "../registry.js";

const execFileAsync = promisify(execFile);

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
  description: "Show the working tree status (git status --porcelain=v1 -b).",
  schema: z.object({}),
  classify: () => ({
    permission: "readonly",
    description: "Run git status",
    command: "git status --porcelain=v1 -b",
  }),
  async run(_args, ctx) {
    const { text, truncated } = await runGit(ctx.workspace, ["status", "--porcelain=v1", "-b"]);
    return { data: { status: text }, meta: { truncated } };
  },
});

const gitDiffSchema = z.object({
  staged: z.boolean().optional().describe("Show staged changes (git diff --cached) instead of unstaged."),
});

const gitDiff = defineTool({
  name: "git_diff",
  description: "Show uncommitted changes (git diff, or git diff --cached when staged is true).",
  schema: gitDiffSchema,
  classify: (args) => ({
    permission: "readonly",
    description: "Run git diff",
    command: args.staged ? "git diff --cached" : "git diff",
  }),
  async run(args, ctx) {
    const gitArgs = args.staged ? ["diff", "--cached"] : ["diff"];
    const { text, truncated } = await runGit(ctx.workspace, gitArgs);
    return { data: { diff: text }, meta: { truncated } };
  },
});

export const gitTools: ToolSpec[] = [gitStatus, gitDiff];
