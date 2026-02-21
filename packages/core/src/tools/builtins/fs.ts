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
import { defineTool, type ToolSpec } from "../registry.js";

const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCHABLE_FILE_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const listFilesSchema = z.object({
  path: z.string().optional().describe("Directory to list, relative to the workspace root."),
  maxDepth: z.number().optional().describe("Maximum recursion depth (default 10)."),
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
    "Recursively list files and directories in the workspace (common build/dependency directories are skipped). Directories end with '/'.",
  schema: listFilesSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `List files under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
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
  offset: z.number().optional().describe("1-based line number to start reading from."),
  limit: z.number().optional().describe("Maximum number of lines to return."),
});

const readFile = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace, optionally a line range.",
  schema: readFileSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read file ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const resolved = resolveForRead(ctx.workspace, args.path);
    if (!fs.existsSync(resolved)) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    if (!fs.statSync(resolved).isFile()) {
      throw new ToolError("not_a_file", `Not a regular file: ${args.path}`);
    }
    let content = fs.readFileSync(resolved, "utf8");
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
  pattern: z.string().describe("Regular expression (falls back to literal text if invalid)."),
  path: z.string().optional().describe("Directory to search, relative to the workspace root."),
  caseSensitive: z.boolean().optional().describe("Case-sensitive matching (default false)."),
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const searchText = defineTool({
  name: "search_text",
  description:
    "Search file contents recursively with a regex (or literal text). Returns matches as {file, line, text}. Skips binary files, files over 1MB, and ignored directories.",
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

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  content: z.string().describe("Full file content to write (UTF-8)."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file (default false)."),
});

const writeFile = defineTool({
  name: "write_file",
  description:
    "Create a file (parent directories are created). Fails if the file exists unless overwrite is true.",
  schema: writeFileSchema,
  classify: (args) => ({
    permission: "write",
    description: `Write file ${args.path} (${args.content.length} chars)`,
    path: args.path,
  }),
  async run(args, ctx) {
    const resolved = resolveForWrite(ctx.workspace, args.path);
    if (fs.existsSync(resolved) && !args.overwrite) {
      throw new ToolError("exists", `File already exists: ${args.path} (pass overwrite:true to replace)`);
    }
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
        oldString: z.string().describe("Exact text to replace; must occur exactly once."),
        newString: z.string().describe("Replacement text."),
      }),
    )
    .describe("Search/replace edits, applied in order, all-or-nothing."),
});

const applyPatch = defineTool({
  name: "apply_patch",
  description:
    "Edit a file with search/replace edits. Each oldString must match exactly once; edits are applied atomically (any failure writes nothing).",
  schema: applyPatchSchema,
  classify: (args) => ({
    permission: "write",
    description: `Apply ${args.edits.length} edit(s) to ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const resolved = resolveForWrite(ctx.workspace, args.path);
    // Editing implies reading current content back into hints: same read rules apply.
    resolveForRead(ctx.workspace, args.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    const content = fs.readFileSync(resolved, "utf8");
    // applyEdits throws on no_match/ambiguous before anything is written.
    const next = applyEdits(content, args.edits);
    fs.writeFileSync(resolved, next, "utf8");
    return { data: { path: args.path, editsApplied: args.edits.length } };
  },
});

export const fsTools: ToolSpec[] = [listFiles, readFile, searchText, writeFile, applyPatch];
