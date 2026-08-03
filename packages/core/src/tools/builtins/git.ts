import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { truncateHeadTail } from "../text.js";
import { callRuntime } from "../runtime-backend.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { resolveForRead } from "../sandbox.js";

const execFileAsync = promisify(execFile);

/** Force English git messages so error-detection regexes work on any locale. */
const GIT_ENV = { ...process.env, LC_ALL: "C" };

/**
 * Run git directly (no shell) inside the workspace.
 *
 * `LC_ALL=C` travels with every invocation: the history tools below read what
 * git prints, and a translated message or date would be parsed wrong on a
 * machine that is not in English.
 */
async function runGit(workspace: string, args: string[]): Promise<{ text: string; truncated: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 10_000_000,
      timeout: 30_000,
      env: GIT_ENV,
    });
    return truncateHeadTail(stdout, DEFAULT_LIMITS.toolOutputMaxChars);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new ToolError("git_error", `git ${args.join(" ")} failed`, {
      stderr: (e.stderr ?? e.message ?? "").slice(0, 2000),
    });
  }
}

/**
 * Guard a model-supplied value that becomes a git argument.
 *
 * There is no shell here, so nothing can be injected — but a value starting
 * with "-" is still read by git as an option, which is how a plain argument
 * becomes `--output=…`. Values are passed after `--` where git allows it, and
 * refused here where it does not.
 */
function checkGitArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new ToolError("invalid_args", `${label} must not be empty`);
  if (trimmed.startsWith("-")) {
    throw new ToolError("invalid_args", `${label} must not start with "-" (it would be read as an option)`);
  }
  return trimmed;
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

// ---------------------------------------------------------------------------
// History: why the code looks like this
// ---------------------------------------------------------------------------

/** Field separator inside one log record; \x1f cannot appear in the fields. */
const FIELD = "\x1f";
const RECORD = "\x1e";

const gitLogSchema = z.object({
  path: z.string().optional().describe("Only commits touching this workspace-relative path (a file or a directory)."),
  limit: z.number().int().min(1).max(100).optional().describe("How many commits to return, newest first (default 20)."),
  author: z.string().max(200).optional().describe("Only commits by this author (substring match, as git does it)."),
});

const gitLog = defineTool({
  name: "git_log",
  description:
    "Recent commits, newest first: hash, author, ISO date and subject, optionally narrowed to a `path` or an `author`. " +
    "Use it to see how a file got to its current state, or what changed recently, without paying for a run_command round trip. Read-only.",
  schema: gitLogSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Run git log${args.path ? ` for ${args.path}` : ""}`,
    command: `git log --max-count=${args.limit ?? 20}${args.path ? ` -- ${args.path}` : ""}`,
    ...(args.path !== undefined ? { path: args.path } : {}),
  }),
  async run(args, ctx) {
    const gitArgs = [
      "log",
      `--max-count=${args.limit ?? 20}`,
      // %aI is ISO 8601 strict, so the date does not depend on the locale.
      `--pretty=format:%H${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`,
    ];
    if (args.author !== undefined) gitArgs.push(`--author=${checkGitArgument(args.author, "author")}`);
    if (args.path !== undefined) {
      resolveForRead(ctx.workspace, args.path);
      gitArgs.push("--", args.path);
    }
    const { text, truncated } = await runGit(ctx.workspace, gitArgs);
    const commits = text
      .split(RECORD)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = "", author = "", date = "", subject = ""] = record.split(FIELD);
        return { hash: hash.slice(0, 12), author, date, subject };
      });
    return { data: { commits, count: commits.length }, meta: { truncated } };
  },
});

const gitBlameSchema = z.object({
  path: z.string().describe("Workspace-relative path of the file to annotate."),
  line: z.number().int().min(1).optional().describe("First line to annotate (1-based); omit to annotate the file."),
  endLine: z.number().int().min(1).optional().describe("Last line to annotate (1-based); defaults to `line`."),
});

/** Cap the annotated span: blaming a whole large file is rarely the question. */
const MAX_BLAME_LINES = 200;

/**
 * Parse `git blame --line-porcelain`: a header line per source line, followed
 * by `key value` lines and then the source line prefixed with a tab. The
 * porcelain format is stable across git versions and locales, which is why it
 * is used here instead of the human-readable one.
 */
function parseBlamePorcelain(text: string): Array<{
  line: number;
  hash: string;
  author: string;
  date: string;
  summary: string;
  text: string;
}> {
  const out: Array<{ line: number; hash: string; author: string; date: string; summary: string; text: string }> = [];
  let current: { line: number; hash: string; author: string; date: string; summary: string } | undefined;
  for (const raw of text.split("\n")) {
    const header = /^([0-9a-f]{7,40}) \d+ (\d+)/.exec(raw);
    if (header) {
      current = { line: Number(header[2]), hash: header[1]!.slice(0, 12), author: "", date: "", summary: "" };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("author ")) current.author = raw.slice("author ".length);
    else if (raw.startsWith("author-time ")) {
      const seconds = Number(raw.slice("author-time ".length));
      current.date = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
    } else if (raw.startsWith("summary ")) current.summary = raw.slice("summary ".length);
    else if (raw.startsWith("\t")) {
      out.push({ ...current, text: raw.slice(1) });
      current = undefined;
    }
  }
  return out;
}

const gitBlame = defineTool({
  name: "git_blame",
  description:
    "Who last changed each line of `path`, and in which commit: hash, author, ISO date, commit subject and the line itself. " +
    "The fastest answer to 'why is this line here' — read the subject, then git_show that commit. Give `line` (and `endLine`) to annotate a range rather than the whole file. Read-only.",
  schema: gitBlameSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Run git blame on ${args.path}${args.line !== undefined ? `:${args.line}` : ""}`,
    command: `git blame ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    resolveForRead(ctx.workspace, args.path);
    const gitArgs = ["blame", "--line-porcelain"];
    if (args.line !== undefined) {
      const end = Math.max(args.line, args.endLine ?? args.line);
      if (end - args.line + 1 > MAX_BLAME_LINES) {
        throw new ToolError("invalid_args", `Annotate at most ${MAX_BLAME_LINES} lines at a time`);
      }
      gitArgs.push(`-L${args.line},${end}`);
    }
    gitArgs.push("--", args.path);
    const { text, truncated } = await runGit(ctx.workspace, gitArgs);
    const lines = parseBlamePorcelain(text);
    return { data: { path: args.path, lines, count: lines.length }, meta: { truncated } };
  },
});

const gitShowSchema = z.object({
  ref: z.string().max(200).describe("Commit to show: a hash from git_log/git_blame, a tag, or HEAD~2."),
  path: z.string().optional().describe("Limit the diff to this workspace-relative path."),
  statOnly: z.boolean().optional().describe("Return only the changed-file summary, not the full diff."),
});

const gitShow = defineTool({
  name: "git_show",
  description:
    "Show the commit named by `ref`: its message and the diff it introduced, optionally limited to a `path` or reduced to a file summary with statOnly. " +
    "Follow a hash from git_blame or git_log with this to find out why a change was made. Read-only.",
  schema: gitShowSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Run git show ${args.ref}`,
    command: `git show ${args.ref}${args.path ? ` -- ${args.path}` : ""}`,
    ...(args.path !== undefined ? { path: args.path } : {}),
  }),
  async run(args, ctx) {
    const ref = checkGitArgument(args.ref, "ref");
    const gitArgs = ["show", "--date=iso-strict"];
    if (args.statOnly) gitArgs.push("--stat");
    gitArgs.push(ref);
    if (args.path !== undefined) {
      resolveForRead(ctx.workspace, args.path);
      gitArgs.push("--", args.path);
    }
    const { text, truncated } = await runGit(ctx.workspace, gitArgs);
    return { data: { ref, output: text }, meta: { truncated } };
  },
});

export const gitTools: ToolSpec[] = [gitStatus, gitDiff, gitCommit, gitLog, gitBlame, gitShow];
