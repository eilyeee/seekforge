import { z } from "zod";
import { ToolError } from "../errors.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { buildRepoMap, findDefinitions } from "../../agent/repo-map.js";
import { ensureAstBackend } from "../../agent/repo-map-ast.js";

const repoMapSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Subtree to map, relative to the workspace root (default '.'). Narrow it on huge repos."),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Directory-tree depth in the Structure section (0-100, default 3)."),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max files given a symbol outline in the Files section (1-1000, default 60)."),
});

const repoMap = defineTool({
  name: "repo_map",
  description:
    'Get a compact structural overview of the codebase WITHOUT reading every file: a directory tree with per-directory file counts, plus a one-line symbol outline (exports / component names) for the most relevant files. Use this FIRST to orient in an unfamiliar or large repo, then drill in with `path` (e.g. "src/views") before reading specific files. Heuristic outlines — confirm details by reading the file.',
  schema: repoMapSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Map repo at ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      throw new ToolError("not_supported", "repo_map is not available with the runtime backend yet");
    }
    await ensureAstBackend(); // best-effort: upgrades extraction to tree-sitter, else regex
    // Validate the subtree stays inside the workspace (throws on traversal).
    resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    const map = buildRepoMap(ctx.workspace, {
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
      ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
    });
    return { data: { map }, meta: {} };
  },
});

const findDefinitionSchema = z.object({
  symbol: z.string().describe("Identifier whose DEFINITION to locate (function/class/const/method/component name)."),
  path: z.string().optional().describe("Subtree to search, relative to the workspace root (default '.')."),
});

const findDefinition = defineTool({
  name: "find_definition",
  description:
    'Find where a symbol is DEFINED/exported across the repo — declarations of functions, classes, consts, methods, components — NOT every mention. Use this for "where is X defined?" instead of search_text (which returns all usages). Heuristic (identifier-only regex); confirm by reading the returned file:line.',
  schema: findDefinitionSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Find definition of ${args.symbol}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      throw new ToolError("not_supported", "find_definition is not available with the runtime backend yet");
    }
    await ensureAstBackend(); // best-effort: tree-sitter when available, else regex
    resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    const definitions = findDefinitions(ctx.workspace, args.symbol, args.path !== undefined ? { path: args.path } : {});
    return { data: { symbol: args.symbol, definitions, count: definitions.length }, meta: {} };
  },
});

export const repoMapTools: ToolSpec[] = [repoMap, findDefinition];
