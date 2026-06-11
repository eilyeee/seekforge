import { listSessions, readCheckpoints, rewindSession } from "@seekforge/core";

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
      console.error("No session with checkpoints found. Nothing to rewind.");
      process.exitCode = 1;
      return;
    }
    id = candidate.id;
  } else if (readCheckpoints(workspace, id).length === 0) {
    console.error(`Session ${id} has no checkpoints; nothing to rewind.`);
    process.exitCode = 1;
    return;
  }

  const result = rewindSession(workspace, id, { dryRun: opts.dryRun });
  const prefix = opts.dryRun ? "[dry-run] " : "";
  for (const p of result.restored) console.log(`${prefix}restore  ${p}`);
  for (const p of result.deleted) console.log(`${prefix}delete   ${p}`);
  for (const s of result.skipped) console.log(`${prefix}skip     ${s.path} (${s.reason})`);

  const verb = opts.dryRun ? "would rewind" : "rewound";
  console.log(
    `${verb} session ${id}: ${result.restored.length} restored, ${result.deleted.length} deleted, ${result.skipped.length} skipped.`,
  );
  console.log("Review the working tree with `seekforge diff`.");
}
