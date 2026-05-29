import { listSessions, readCheckpoints, rewindSession } from "@seekforge/core";
import { t } from "../i18n.js";

export type RewindOptions = { dryRun?: boolean };

/**
 * Undoes all file changes a session made by restoring each file's pre-session
 * checkpoint (created files are deleted). Defaults to the most recent
 * non-running top-level session that has checkpoints.
 */
export function rewindCommand(sessionId: string | undefined, opts: RewindOptions = {}): void {
  const workspace = process.cwd();

  let id = sessionId;
  if (!id) {
    const candidate = listSessions(workspace).find(
      (s) => s.status !== "running" && readCheckpoints(workspace, s.id).length > 0,
    );
    if (!candidate) {
      console.error(t("err.noSessionsFound"));
      process.exitCode = 1;
      return;
    }
    id = candidate.id;
  } else if (readCheckpoints(workspace, id).length === 0) {
    console.error(t("err.sessionNoCheckpoints", { id }));
    process.exitCode = 1;
    return;
  }

  const result = rewindSession(workspace, id, { dryRun: opts.dryRun });
  const prefix = opts.dryRun ? "[dry-run] " : "";
  for (const p of result.restored) console.log(`${prefix}${t("status.restoredFile", { path: p })}`);
  for (const p of result.deleted) console.log(`${prefix}${t("status.deletedFile", { path: p })}`);
  for (const s of result.skipped) console.log(`${prefix}${t("status.skippedFile", { path: s.path, reason: s.reason })}`);

  const tKey = opts.dryRun ? "status.dryRunRewound" : "status.rewound";
  console.log(t(tKey, { id, restored: result.restored.length, deleted: result.deleted.length, skipped: result.skipped.length }));
  console.log(t("status.reviewDiff"));
}
