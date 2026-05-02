import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { applyEdits } from "../edits.js";
import {
  DEFAULT_IGNORE_DIRS,
  isSensitiveBasename,
  resolveForRead,
  resolveForWrite,
  resolveInsideWorkspace,
} from "../sandbox.js";
import { truncateHeadTail } from "../text.js";
import { callRuntime } from "../runtime-backend.js";
import { defineTool, type ToolSpec } from "../registry.js";
import type { ToolContext } from "../index.js";

const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCHABLE_FILE_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const listFilesSchema = z.object({
  path: z.string().optional().describe("Directory to list, relative to the workspace root (default '.')."),
  maxDepth: z.number().optional().describe("Maximum recursion depth (default 10); lower it for a quick overview."),
});

function walkEntries(root: string, maxDepth: number): { entries: string[]; truncated: boolean } {
  const entries: string[] = [];
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (truncated) return;
      if (d.isDirectory() && DEFAULT_IGNORE_DIRS.has(d.name)) continue;
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (d.isDirectory()) {
        entries.push(childRel + "/");
        walk(path.join(dir, d.name), childRel, depth + 1);
      } else {
        entries.push(childRel);
      }
    }
  };

  walk(root, "", 1);
  return { entries, truncated };
}

const listFiles = defineTool({
  name: "list_files",
  description:
    "Recursively list files and directories under path; directories end with '/'. Prefer this over search_text when exploring project structure rather than hunting for specific code. Build/dependency directories (node_modules, .git, dist, ...) are skipped and output caps at 500 entries — narrow path or maxDepth if truncated.",
  schema: listFilesSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `List files under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      const res = await callRuntime<{ entries: string[]; truncated: boolean }>(
        ctx.runtime,
        "list_files",
        ctx.workspace,
        { path: args.path ?? ".", maxDepth: args.maxDepth ?? 10 },
      );
      return {
        data: { entries: res.entries, count: res.entries.length, truncated: res.truncated },
        meta: { truncated: res.truncated },
      };
    }
    const root = resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ToolError("not_found", `Not a directory: ${args.path ?? "."}`);
    }
    const maxDepth = args.maxDepth ?? 10;
    const { entries, truncated } = walkEntries(root, maxDepth);
    if (truncated) entries.push(`... [truncated at ${MAX_LIST_ENTRIES} entries]`);
    return {
      data: { entries, count: entries.length, truncated },
      meta: { truncated },
    };
  },
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z.number().optional().describe("1-based line number to start reading from (combine with limit for large files)."),
  limit: z.number().optional().describe("Maximum number of lines to return."),
});

const readFile = defineTool({
  name: "read_file",
  description:
    "Read the UTF-8 text file at path. For large files pass offset (1-based line) and limit to read only the range you need — output beyond 20k chars is head/tail truncated. Do not re-read a file you have not changed since the last read; the earlier content is still valid.",
  schema: readFileSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read file ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    let content: string;
    if (ctx.runtime) {
      const res = await callRuntime<{ content: string }>(ctx.runtime, "read_file", ctx.workspace, {
        path: args.path,
      });
      content = res.content;
    } else {
      const resolved = resolveForRead(ctx.workspace, args.path);
      if (!fs.existsSync(resolved)) {
        throw new ToolError("not_found", `File not found: ${args.path}`);
      }
      if (!fs.statSync(resolved).isFile()) {
        throw new ToolError("not_a_file", `Not a regular file: ${args.path}`);
      }
      content = fs.readFileSync(resolved, "utf8");
    }
    const totalLines = content.split("\n").length;
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max((args.offset ?? 1) - 1, 0);
      const end = args.limit !== undefined ? start + args.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    const { text, truncated } = truncateHeadTail(content, DEFAULT_LIMITS.toolOutputMaxChars);
    return {
      data: { path: args.path, content: text, totalLines },
      meta: { truncated },
    };
  },
});

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

const searchTextSchema = z.object({
  pattern: z
    .string()
    .describe("JavaScript regular expression, e.g. \"function\\\\s+createUser\" (an invalid regex is retried as literal text)."),
  path: z.string().optional().describe("File or directory to search, relative to the workspace root (default '.')."),
  caseSensitive: z.boolean().optional().describe("Case-sensitive matching (default false)."),
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const searchText = defineTool({
  name: "search_text",
  description:
    "Your FIRST tool for locating code: recursively search file contents for a regex pattern (e.g. \"function\\s+createUser\"); an invalid regex falls back to a literal-text search. Matching is per-line, case-insensitive by default, returns {file, line, text} up to 200 matches; binary files, files over 1MB, and ignored directories are skipped. Pass path to narrow the search.",
  schema: searchTextSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Search for /${args.pattern}/ under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    const root = resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    if (!fs.existsSync(root)) {
      throw new ToolError("not_found", `Path not found: ${args.path ?? "."}`);
    }
    const flags = args.caseSensitive ? "" : "i";
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, flags);
    } catch {
      re = new RegExp(escapeRegExp(args.pattern), flags);
    }

    const matches: Array<{ file: string; line: number; text: string }> = [];
    let truncated = false;

    const searchFile = (filePath: string, rel: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > MAX_SEARCHABLE_FILE_BYTES) return;
      if (isSensitiveBasename(path.basename(filePath))) return;
      const buf = fs.readFileSync(filePath);
      if (buf.subarray(0, 8192).includes(0)) return; // binary sniff: NUL byte
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          return;
        }
        const line = lines[i] as string;
        if (re.test(line)) {
          matches.push({ file: rel, line: i + 1, text: line.slice(0, 500) });
        }
      }
    };

    const walk = (dir: string, rel: string): void => {
      if (truncated) return;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (truncated) return;
        const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
        const childPath = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.has(d.name)) continue;
          walk(childPath, childRel);
        } else if (d.isFile()) {
          searchFile(childPath, childRel);
        }
      }
    };

    if (fs.statSync(root).isFile()) {
      searchFile(root, path.basename(root));
    } else {
      walk(root, "");
    }
    return {
      data: { matches, count: matches.length, truncated },
      meta: { truncated },
    };
  },
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

/**
 * Fetches a file's current content through the runtime for checkpointing
 * before a delegated write. A missing/unreadable file maps to null (the
 * checkpoint semantics for "did not exist before this session").
 */
async function runtimeBeforeContent(ctx: ToolContext, relPath: string): Promise<string | null> {
  try {
    const res = await callRuntime<{ content: string }>(ctx.runtime!, "read_file", ctx.workspace, {
      path: relPath,
    });
    return res.content;
  } catch (err) {
    if (err instanceof ToolError && (err.code === "not_found" || err.code === "io_error")) return null;
    throw err;
  }
}

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  content: z.string().describe("Complete file content (UTF-8) — replaces the entire file, nothing is merged."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file (default false)."),
});

const writeFile = defineTool({
  name: "write_file",
  description:
    "Write content as the COMPLETE file at path (parent directories are created). Whole-file replacement: use only for new files or intentional full rewrites — use apply_patch for any edit to an existing file. Fails if the file already exists unless overwrite is true.",
  schema: writeFileSchema,
  classify: (args) => ({
    permission: "write",
    description: `Write file ${args.path} (${args.content.length} chars)`,
    path: args.path,
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      if (ctx.checkpoint) {
        ctx.checkpoint(args.path, await runtimeBeforeContent(ctx, args.path));
      }
      await callRuntime<{ path: string }>(ctx.runtime, "write_file", ctx.workspace, {
        path: args.path,
        content: args.content,
        overwrite: args.overwrite ?? false,
      });
      return { data: { path: args.path, bytesWritten: Buffer.byteLength(args.content, "utf8") } };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    const exists = fs.existsSync(resolved);
    if (exists && !args.overwrite) {
      throw new ToolError("exists", `File already exists: ${args.path} (pass overwrite:true to replace)`);
    }
    ctx.checkpoint?.(args.path, exists ? fs.readFileSync(resolved, "utf8") : null);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, args.content, "utf8");
    return { data: { path: args.path, bytesWritten: Buffer.byteLength(args.content, "utf8") } };
  },
});

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

const applyPatchSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  edits: z
    .array(
      z.object({
        oldString: z
          .string()
          .describe(
            "Exact text copied VERBATIM from the current file (whitespace included); must occur exactly once — include surrounding lines to disambiguate.",
          ),
        newString: z.string().describe("Replacement text, written with the same exactness as oldString."),
      }),
    )
    .describe("Search/replace edits, applied in order, all-or-nothing."),
});

const applyPatch = defineTool({
  name: "apply_patch",
  description:
    "Edit the file at path with search/replace edits, applied atomically (any failure writes nothing). Each oldString must be copied verbatim from the CURRENT file content (your latest read) and match exactly once. If a patch fails, re-read the file before retrying; prefer several small targeted edits over one large one.",
  schema: applyPatchSchema,
  classify: (args) => ({
    permission: "write",
    description: `Apply ${args.edits.length} edit(s) to ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      if (ctx.checkpoint) {
        ctx.checkpoint(args.path, await runtimeBeforeContent(ctx, args.path));
      }
      const res = await callRuntime<{ path: string; editsApplied: number }>(
        ctx.runtime,
        "apply_patch",
        ctx.workspace,
        { path: args.path, edits: args.edits },
      );
      return { data: res };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    // Editing implies reading current content back into hints: same read rules apply.
    resolveForRead(ctx.workspace, args.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    const content = fs.readFileSync(resolved, "utf8");
    // applyEdits throws on no_match/ambiguous before anything is written.
    const next = applyEdits(content, args.edits);
    ctx.checkpoint?.(args.path, content);
    fs.writeFileSync(resolved, next, "utf8");
    return { data: { path: args.path, editsApplied: args.edits.length } };
  },
});

export const fsTools: ToolSpec[] = [listFiles, readFile, searchText, writeFile, applyPatch];
