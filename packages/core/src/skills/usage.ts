import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { acquireSessionLease } from "../agent/session-lease.js";
import { writeAllSync } from "../util/fs.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { SkillSelection } from "./types.js";

export const MAX_SKILL_USAGE_BYTES = 8 * 1024 * 1024;
const RETAIN_SKILL_USAGE_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_REASON_CHARS = 2_000;
const USAGE_REL_PATH = path.join(".seekforge", "skills-usage.jsonl");

/** Appends one JSONL entry per selection to .seekforge/skills-usage.jsonl. */
export function logSkillUsage(workspace: string, sessionId: string, selections: SkillSelection[]): void {
  if (selections.length === 0) return;
  // Observability is best-effort: a corrupt/link/FIFO usage target must never
  // fail or block the foreground Agent run.
  let lease: ReturnType<typeof acquireSessionLease> | undefined;
  let fd: number | undefined;
  try {
    lease = acquireSessionLease(workspace, "skills-usage");
    const ts = new Date().toISOString();
    const lines = selections
      .map(
        (sel) =>
          `${JSON.stringify({
            ts,
            sessionId,
            skillId: sel.skill.id,
            scope: sel.skill.scope,
            score: sel.score,
            reason: sel.reason.slice(0, MAX_USAGE_REASON_CHARS),
          })}\n`,
      )
      .join("");
    const bytes = Buffer.from(lines, "utf8");
    if (bytes.length > MAX_SKILL_USAGE_BYTES) return;

    const root = realpathSync(workspace);
    const target = path.join(root, USAGE_REL_PATH);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing === undefined) {
      writeWorkspaceStateFileAtomic(root, USAGE_REL_PATH, "");
    } else if (existing.isSymbolicLink() || !existing.isFile() || existing.size > MAX_SKILL_USAGE_BYTES) {
      return;
    } else if (existing.size + bytes.length > MAX_SKILL_USAGE_BYTES) {
      const raw = readWorkspaceStateFile(root, USAGE_REL_PATH, MAX_SKILL_USAGE_BYTES);
      if (raw === undefined) return;
      const start = Math.max(0, raw.length - RETAIN_SKILL_USAGE_BYTES);
      const newline = start === 0 ? -1 : raw.indexOf("\n", start);
      const boundary = start === 0 ? 0 : newline === -1 ? raw.length : newline + 1;
      writeWorkspaceStateFileAtomic(root, USAGE_REL_PATH, raw.slice(boundary));
    }

    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return;
    writeAllSync(fd, bytes);
  } catch {
    // Best-effort usage telemetry only.
  } finally {
    if (fd !== undefined) closeSync(fd);
    lease?.release();
  }
}
