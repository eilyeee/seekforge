import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listSessions, pruneSessions } from "@seekforge/core";
import { loadConfig } from "../config.js";
import { t } from "../i18n.js";
import { formatUsage } from "../render.js";

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function sessionsCommand(): void {
  const sessions = listSessions(process.cwd());
  if (sessions.length === 0) {
    console.log(t("cmd.sessions.none"));
    return;
  }
  for (const s of sessions) {
    const cost = s.usage ? ` $${s.usage.costUsd.toFixed(4)}` : "";
    console.log(t("cmd.sessions.output", { id: s.id, status: s.status, cost, task: truncate(s.task, 60) }));
  }
}

export type PruneOptions = { olderThan?: string; keepLast?: string; dryRun?: boolean };

export function sessionsPruneCommand(opts: PruneOptions): void {
  const parseInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    return /^\d+$/.test(value) ? Number(value) : Number.NaN;
  };
  const olderThanDays = parseInteger(opts.olderThan);
  const keepLast = parseInteger(opts.keepLast);
  if (olderThanDays === undefined && keepLast === undefined) {
    console.error(t("cmd.sessions.pruneSpecify"));
    process.exitCode = 1;
    return;
  }
  if (
    (olderThanDays !== undefined && !Number.isSafeInteger(olderThanDays)) ||
    (keepLast !== undefined && !Number.isSafeInteger(keepLast))
  ) {
    console.error(t("cmd.sessions.pruneNumbers"));
    process.exitCode = 1;
    return;
  }
  // Reject nonsensical bounds: a negative --older-than is a future cutoff and
  // --keep-last 0 (or negative) keeps nothing — both would delete every session.
  if ((olderThanDays !== undefined && olderThanDays < 0) || (keepLast !== undefined && keepLast <= 0)) {
    console.error(t("cmd.sessions.pruneNumbers"));
    process.exitCode = 1;
    return;
  }
  const result = pruneSessions(process.cwd(), { olderThanDays, keepLast, dryRun: opts.dryRun });
  if (result.removed.length === 0) {
    console.log(t("cmd.sessions.pruneNone"));
    return;
  }
  const verb = opts.dryRun ? t("cmd.sessions.pruneWouldRemove") : t("cmd.sessions.pruneRemoved");
  console.log(t("cmd.sessions.pruneResult", { verb, removed: result.removed.length, kept: result.kept }));
  if (opts.dryRun) for (const id of result.removed) console.log(`  ${id}`);
}

export function statusCommand(): void {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const sessions = listSessions(projectPath);
  const last = sessions[0];

  console.log(t("cmd.status.project", { path: projectPath }));
  console.log(
    t("cmd.status.config", {
      path: existsSync(join(projectPath, ".seekforge"))
        ? t("cmd.status.configInitialized")
        : t("cmd.status.configNotInit"),
    }),
  );
  console.log(
    t("cmd.status.apiKey", { key: config.apiKey ? `${config.apiKey.slice(0, 6)}**** ` : t("cmd.status.apiKeyMasked") }),
  );
  console.log(t("cmd.status.model", { model: config.model ?? t("cmd.status.modelDefault") }));
  console.log(t("cmd.status.global", { path: join(homedir(), ".seekforge", "config.json") }));
  console.log(t("cmd.status.sessions", { count: sessions.length }));
  if (last) {
    console.log(t("cmd.status.last", { id: last.id, status: last.status, task: truncate(last.task, 50) }));
    if (last.usage) console.log(`           ${formatUsage(last.usage)}`);
  }
}
