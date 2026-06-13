import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { DEFAULT_IGNORE_DIRS, resolveInsideWorkspace } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";

const MAX_GLOB_MATCHES = 1000;

// ---------------------------------------------------------------------------
// glob → RegExp compiler
// ---------------------------------------------------------------------------
//
// Self-contained (no new dependency). Supports the subset Claude's Glob uses:
//   *            matches any run of chars EXCEPT "/"  (does not cross dirs)
//   **           matches any run of chars INCLUDING "/" (crosses dirs)
//   ?            matches a single char except "/"
//   {a,b,c}      alternation (no nesting)
//   [...]        character class, passed through to RegExp (with [!..] → [^..])
// Everything else is matched literally. Patterns are anchored (full-path match).
//
// "**" handling: a path segment that is exactly "**" (optionally with a leading
// or trailing "/") is allowed to match zero or more directory segments, so
// "**/*.ts" matches "a.ts" as well as "src/a.ts". A bare "**" inside a segment
// (e.g. "a**b") behaves like ".*" without the zero-dir optimisation.

const REGEXP_SPECIAL = new Set([".", "+", "^", "$", "(", ")", "|", "\\"]);

function escapeLiteral(ch: string): string {
  return REGEXP_SPECIAL.has(ch) ? "\\" + ch : ch;
}

/** Compile one glob pattern (no leading "./") into an anchored RegExp source. */
export function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const ch = pattern[i] as string;

    if (ch === "*") {
      // Look for "**".
      if (pattern[i + 1] === "*") {
        // Consume the run of '*'.
        let j = i + 2;
        while (pattern[j] === "*") j++;
        const before = pattern[i - 1];
        const after = pattern[j];
        // "**/" or "/**/"  or leading "**/" : match zero+ path segments.
        if ((before === undefined || before === "/") && after === "/") {
          // Swallow the trailing slash; "(?:.*/)?" lets it match zero dirs.
          out += "(?:.*/)?";
          i = j + 1;
          continue;
        }
        // trailing "/**" or bare "**": match anything including "/".
        out += ".*";
        i = j;
        continue;
      }
      // single "*": anything except "/".
      out += "[^/]*";
      i++;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const body = pattern.slice(i + 1, end);
        const alts = body.split(",").map((alt) =>
          alt
            .split("")
            .map((c) => (c === "*" || c === "?" ? globToRegExpSource(c) : escapeLiteral(c)))
            .join(""),
        );
        out += "(?:" + alts.join("|") + ")";
        i = end + 1;
        continue;
      }
      out += "\\{";
      i++;
      continue;
    }

    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += "[" + cls + "]";
        i = end + 1;
        continue;
      }
      out += "\\[";
      i++;
      continue;
    }

    out += escapeLiteral(ch);
    i++;
  }

  return out;
}

/** Compile a glob to an anchored RegExp matching a workspace-relative path. */
export function compileGlob(pattern: string): RegExp {
  // Normalize a leading "./".
  const clean = pattern.replace(/^\.\//, "");
  return new RegExp("^" + globToRegExpSource(clean) + "$");
}

// ---------------------------------------------------------------------------
// glob tool
// ---------------------------------------------------------------------------

const globSchema = z.object({
  pattern: z
    .string()
    .describe(
      'Glob pattern matched against workspace-relative paths, e.g. "**/*.test.ts", "src/**/*.{ts,tsx}". "**" crosses directories, "*" does not cross "/".',
    ),
  path: z
    .string()
    .optional()
    .describe("Base directory to search under, relative to the workspace root (default '.')."),
});

/**
 * Walk `root`, collecting files whose path (relative to the walk base) matches
 * `re`. Reuses list_files's ignore behavior: DEFAULT_IGNORE_DIRS and dot-dirs
 * are skipped, symlinked directories are not followed. Path-only — no file
 * contents are read, so this stays synchronous like list_files.
 */
function walkGlob(
  root: string,
  re: RegExp,
): { matches: Array<{ rel: string; mtimeMs: number }>; truncated: boolean } {
  const matches: Array<{ rel: string; mtimeMs: number }> = [];
  let truncated = false;

  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (truncated) return;
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      const childPath = path.join(dir, d.name);
      if (d.isDirectory()) {
        // Skip ignored dirs, dot-dirs, and symlinked dirs (don't follow).
        if (DEFAULT_IGNORE_DIRS.has(d.name) || d.name.startsWith(".")) continue;
        walk(childPath, childRel);
      } else if (d.isFile() || d.isSymbolicLink()) {
        if (!re.test(childRel)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(childPath).mtimeMs;
        } catch {
          // Broken symlink or race: keep it with mtime 0 (sorts last).
        }
        if (matches.length >= MAX_GLOB_MATCHES) {
          truncated = true;
          return;
        }
        matches.push({ rel: childRel, mtimeMs });
      }
    }
  };

  walk(root, "");
  return { matches, truncated };
}

const glob = defineTool({
  name: "glob",
  description:
    'Find files by NAME/PATH pattern (not contents). Use this when you know roughly what a file is called or its extension — e.g. "**/*.test.ts", "src/**/*.{ts,tsx}", "**/config.*". Returns workspace-relative paths sorted by modification time (newest first), capped at 1000. "**" crosses directories, "*" does not cross "/". To search inside files for code/text, use search_text instead. Build/dependency and dot directories are skipped.',
  schema: globSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Glob ${args.pattern} under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    const root = resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ToolError("not_found", `Not a directory: ${args.path ?? "."}`);
    }
    const re = compileGlob(args.pattern);
    const { matches, truncated } = walkGlob(root, re);
    // Newest first; ties broken by path for a stable order.
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
    const files = matches.map((m) => m.rel);
    return {
      data: { files, count: files.length, truncated },
      meta: { truncated },
    };
  },
});

export const globTools: ToolSpec[] = [glob];
