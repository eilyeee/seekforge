/**
 * search_memory: a read-only (L0) tool that lets the agent query approved
 * project memory ON DEMAND, mid-task — beyond the auto-injected brief that the
 * session prompt already showed. This is the "memory tool" pattern: the brief
 * surfaces a small, budgeted digest at session start; this tool lets the model
 * look up a specific convention/command/gotcha when it needs one.
 *
 * It merges PROJECT + GLOBAL + SUBDIR memory, ranks bullets against `query` with
 * the shared scoring helper (brief.ts), and returns the top matches tagged with
 * their source. No 800/1200-char brief cap — an explicit lookup wants the
 * matches. Best-effort: empty/missing memory yields a clear "no memory" result,
 * never an error.
 */

import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";
import {
  ALWAYS_INCLUDE_TYPES,
  parseMemoryBullet,
  rankMemoryBullets,
  recordFactRetrieval,
  readGlobalMemory,
  readProjectMemory,
  readSubdirMemories,
  type MemoryCandidateBullet,
} from "../../memory/index.js";

/** Max bullets returned. Higher than the brief's budget — this is a lookup. */
const MAX_RESULTS = 15;

const searchMemorySchema = z.object({
  query: z
    .string()
    .describe("What to look up in project memory (a topic, command, path, or question)."),
});

/** A candidate bullet plus a human-readable source tag for the output. */
type SourcedBullet = MemoryCandidateBullet & { source: string };

/** Collect every memory bullet across project + global + subdir sources. */
function collectAllBullets(workspace: string): SourcedBullet[] {
  const out: SourcedBullet[] = [];
  const seen = new Set<string>();
  const add = (memory: string | undefined, source: string, pathContext?: string): void => {
    if (!memory) return;
    for (const rawLine of memory.split("\n")) {
      const bullet = parseMemoryBullet(rawLine);
      if (!bullet) continue;
      const line = `- [${bullet.type}] ${bullet.text}`;
      if (seen.has(line)) continue; // identical bullet already collected (first source wins)
      seen.add(line);
      out.push({ line, type: bullet.type, source, ...(pathContext ? { pathContext } : {}) });
    }
  };

  // Order = precedence on identical-line dedup: project > subdir > global.
  add(readProjectMemory(workspace), "project");
  for (const sub of readSubdirMemories(workspace)) {
    const rel = sub.relDir.split(/[\\/]+/).join("/");
    add(sub.content, `subdir:${rel}`, rel);
  }
  add(readGlobalMemory(), "global");
  return out;
}

const searchMemory = defineTool({
  name: "search_memory",
  description:
    "Look up project memory ON DEMAND by query — project conventions, commands, paths, or gotchas BEYOND what the auto-injected memory brief already showed (e.g. \"how are tests run here\", \"model config convention\", \"where do migrations live\"). Merges project + global + monorepo subdir memory, returns the top matching remembered facts tagged with their source. Read-only; do NOT use it to re-fetch the brief.",
  schema: searchMemorySchema,
  classify: () => ({ permission: "readonly", description: "Search project memory" }),
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(args, ctx) {
    // Best-effort throughout: memory is non-essential and the contract is
    // "never throw" — any fs/parse trouble degrades to a clear empty result.
    let all: SourcedBullet[] = [];
    try {
      all = collectAllBullets(ctx.workspace);
    } catch {
      all = [];
    }

    const query = (args.query ?? "").trim();
    if (all.length === 0) {
      return { data: { text: "No project memory found (no remembered facts yet)." } };
    }

    let chosen: SourcedBullet[];
    if (query.length === 0) {
      // Empty query: return the always-include (broadly useful) facts first,
      // then fill from the rest — capped. No relevance to rank on.
      const always = all.filter((b) => ALWAYS_INCLUDE_TYPES.has(b.type));
      const rest = all.filter((b) => !ALWAYS_INCLUDE_TYPES.has(b.type));
      chosen = [...always, ...rest].slice(0, MAX_RESULTS);
    } else {
      const ranked = rankMemoryBullets(query, all);
      // Keep only bullets with any signal; if NOTHING matches, say so clearly
      // rather than returning irrelevant noise.
      const matched = ranked.filter((b) => b.score > 0);
      if (matched.length === 0) {
        return {
          data: { text: `No matching memory for "${query}".` },
        };
      }
      chosen = matched.slice(0, MAX_RESULTS);
    }

    const header =
      query.length === 0
        ? `Project memory (${chosen.length} fact${chosen.length === 1 ? "" : "s"}):`
        : `Project memory matching "${query}" (${chosen.length} fact${chosen.length === 1 ? "" : "s"}):`;
    const lines = chosen.map((b) => `${b.line}  (${b.source})`);
    // Only root project facts have this workspace's fact-meta sidecar.
    recordFactRetrieval(
      ctx.workspace,
      chosen.filter((b) => b.source === "project").map((b) => b.line).join("\n"),
    );
    return { data: { text: [header, ...lines].join("\n") } };
  },
});

export const memoryTools: ToolSpec[] = [searchMemory];
