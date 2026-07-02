import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSessionAudit, listSessions, renderSessionAuditMarkdown } from "@seekforge/core";
import { fail } from "../colors.js";
import { t } from "../i18n.js";

export type AuditOptions = {
  /** Emit the raw SessionAudit as JSON instead of the markdown report. */
  json?: boolean;
  /** Write the chosen format to this file instead of stdout. */
  output?: string;
};

/**
 * `seekforge audit <session-id>` — assembles a reviewable, deterministic report
 * of what an agent did in a stored session (prompts, assistant replies, every
 * tool call with a compacted args preview and outcome, and the files it
 * changed). Reads the on-disk trace only; no model calls, no network. Resolves
 * the session in the cwd project, mirroring `replay`/`sessions`.
 */
export function auditCommand(sessionId: string, opts: AuditOptions = {}): void {
  const workspace = process.cwd();

  const audit = buildSessionAudit(workspace, sessionId);
  if (!audit) {
    const known = listSessions(workspace, { includeSubagents: true })
      .slice(0, 5)
      .map((s) => s.id);
    const hint = known.length > 0 ? t("err.replayUnknownHint", { ids: known.join(", ") }) : t("err.replayNoSessions");
    fail(t("err.replayUnknown", { id: sessionId }), { hint });
    return;
  }

  const out = opts.json ? `${JSON.stringify(audit, null, 2)}\n` : renderSessionAuditMarkdown(audit);

  if (opts.output) {
    const target = resolve(workspace, opts.output);
    writeFileSync(target, out);
    console.log(t("cmd.audit.wrote", { path: target }));
    return;
  }

  process.stdout.write(out);
}
