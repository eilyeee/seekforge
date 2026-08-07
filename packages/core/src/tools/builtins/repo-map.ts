import { z } from "zod";
import { resolveInsideWorkspace } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { buildRepoMap, findDefinitions, scanExtensions, scanSubtree } from "../../agent/repo-map.js";
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

/**
 * Why these two tools do not route through the Rust runtime, and no longer
 * refuse to run when one is configured.
 *
 * They used to throw `not_supported` the moment `ctx.runtime` was set, so
 * turning on `runtimeBin` — which the documentation sells as defense-in-depth
 * for file I/O, commands and git — silently removed the agent's two ways of
 * orienting in a repository. Nothing said so. The model just started getting
 * errors from the tools it is told to use FIRST.
 *
 * Running them locally is not a hole in that containment, which is the only
 * reason the refusal could have been justified:
 *
 *   - the subtree is resolved with realpath and rejected if it leaves the
 *     workspace (resolveSubtree), and again by resolveInsideWorkspace here;
 *   - readdir reports an entry's OWN type, so a symlink is neither descended
 *     as a directory nor listed as a file: a link to /etc inside the workspace
 *     contributes nothing, and never reaches the read layer at all;
 *   - and independently, every read goes through readWorkspaceStateFile, which
 *     opens with O_NOFOLLOW and re-checks the target — so even if the walk
 *     later started resolving entries, a symlinked FILE would still not be
 *     read.
 *
 * All three are asserted in repo-map-containment.test.ts. Both tools are
 * read-only and write nothing, so there is no mutation for the runtime to
 * re-check even in principle.
 */
const repoMap = defineTool({
  name: "repo_map",
  description:
    'Get a compact structural overview of the codebase WITHOUT reading every file: a directory tree with per-directory file counts, plus a one-line symbol outline (`defines: …` — the classes/functions/types each file declares) for the most relevant files. Use this FIRST to orient in an unfamiliar or large repo, then drill in with `path` (e.g. "src/views") before reading specific files. Heuristic outlines — confirm details by reading the file.',
  schema: repoMapSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Map repo at ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    // Deliberately NOT gated on ctx.runtime — see the note above runMapLocally.
    // Validate the subtree stays inside the workspace (throws on traversal).
    resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    // Walk once, then load tree-sitter grammars for the languages this
    // workspace actually contains — a Go repo has no reason to pay for the
    // Kotlin grammar, and the whole shipped set costs 454MB.
    const scan = scanSubtree(ctx.workspace, args.path ?? ".");
    if (scan) await ensureAstBackend(scanExtensions(scan)); // best-effort; else regex
    const map = buildRepoMap(ctx.workspace, {
      ...(scan ? { scan } : {}),
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
    // Same reasoning as repo_map: read-only, contained, no runtime needed.
    resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    const scan = scanSubtree(ctx.workspace, args.path ?? ".");
    if (scan) await ensureAstBackend(scanExtensions(scan)); // best-effort; else regex
    const definitions = findDefinitions(ctx.workspace, args.symbol, {
      ...(scan ? { scan } : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
    });
    return { data: { symbol: args.symbol, definitions, count: definitions.length }, meta: {} };
  },
});

export const repoMapTools: ToolSpec[] = [repoMap, findDefinition];
