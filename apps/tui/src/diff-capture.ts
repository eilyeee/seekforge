/**
 * Before/after file-content capture around the write tools (apply_patch,
 * write_file). On tool.started we snapshot the target file; on the matching
 * successful tool.completed we re-read it and produce DiffLines for the
 * DiffCard. Pairing uses a per-tool-name LIFO stack, mirroring the reducer's
 * running-tool-row pairing. Never throws — any failure yields null.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "@seekforge/shared";
import type { DiffLine } from "./model.js";
import { computeDiffLines } from "./diff.js";

const WRITE_TOOLS = new Set(["apply_patch", "write_file"]);

export type CapturedDiff = { path: string; lines: DiffLine[] };

/** null entries keep the LIFO aligned when the started event was unusable. */
type Pending = { relPath: string; absPath: string; before: string | null } | null;

/**
 * Creates a stateful tracker scoped to one run. Feed it every AgentEvent;
 * it returns a CapturedDiff when a write tool completed successfully and
 * actually changed the file, otherwise null.
 */
export function createDiffCapture(workspace: string): {
  onEvent(e: AgentEvent): CapturedDiff | null;
} {
  const root = path.resolve(workspace);
  const stacks = new Map<string, Pending[]>();

  const resolveInside = (rel: unknown): { relPath: string; absPath: string } | null => {
    if (typeof rel !== "string" || rel === "") return null;
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return { relPath: rel, absPath: abs };
  };

  const readOrNull = (abs: string): string | null => {
    try {
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };

  return {
    onEvent(e: AgentEvent): CapturedDiff | null {
      try {
        if (e.type === "tool.started" && WRITE_TOOLS.has(e.toolName)) {
          const target = resolveInside((e.args as { path?: unknown } | null)?.path);
          const stack = stacks.get(e.toolName) ?? [];
          stack.push(target ? { ...target, before: readOrNull(target.absPath) } : null);
          stacks.set(e.toolName, stack);
          return null;
        }
        if (e.type === "tool.completed" && WRITE_TOOLS.has(e.toolName)) {
          const pending = stacks.get(e.toolName)?.pop();
          if (!pending || !e.result.ok) return null;
          const after = readOrNull(pending.absPath);
          const lines = computeDiffLines(pending.before, after);
          if (lines.length === 0) return null;
          return { path: pending.relPath, lines };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
