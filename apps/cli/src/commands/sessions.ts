import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listSessions,
  loadSessionMessages,
  pruneSessions,
  readSessionMeta,
  renameSession,
  sessionName,
  type SessionMeta,
} from "@seekforge/core";
import { clipLine } from "@seekforge/shared/format";
import { fail } from "../colors.js";
import { loadConfig } from "../config.js";
import { t } from "../i18n.js";
import { formatUsage } from "../render.js";

function truncate(text: string, max: number): string {
  return clipLine(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * One `sessions` row: id, status, cost, and the name (when set) before the
 * task's first line — later lines are pasted input or carried `!` output.
 */
export function formatSessionLine(workspace: string, s: SessionMeta, opts: { cost?: boolean } = {}): string {
  const cost = opts.cost !== false && s.usage ? ` $${s.usage.costUsd.toFixed(4)}` : "";
  const name = sessionName(workspace, s.id);
  const firstLine = s.task.split("\n").find((line) => line.trim() !== "") ?? "";
  const task = name ? `«${name}» ${firstLine}` : firstLine;
  return t("cmd.sessions.output", { id: s.id, status: s.status, cost, task: truncate(task, 72) });
}

export function sessionsCommand(): void {
  const workspace = process.cwd();
  const sessions = listSessions(workspace);
  if (sessions.length === 0) {
    console.log(t("cmd.sessions.none"));
    return;
  }
  for (const s of sessions) console.log(formatSessionLine(workspace, s));
}

/** `sessions rename <id> <title...>`: name a session; an empty title clears the name. */
export function sessionsRenameCommand(id: string, titleParts: string[]): void {
  const workspace = process.cwd();
  const title = titleParts.join(" ").replace(/\s+/g, " ").trim();
  if (!readSessionMeta(workspace, id)) {
    fail(t("err.sessionNotFound", { id }), { hint: t("err.sessionNotFoundHint") });
    return;
  }
  try {
    renameSession(workspace, id, title);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const name = sessionName(workspace, id);
  console.log(name ? t("cmd.sessions.renamed", { id, title: name }) : t("cmd.sessions.nameCleared", { id }));
}

/** Everything `sessions show` reports about one session. */
export function describeSession(workspace: string, meta: SessionMeta): Record<string, unknown> {
  let messages: number | undefined;
  try {
    messages = loadSessionMessages(workspace, meta.id).length;
  } catch {
    messages = undefined;
  }
  const name = sessionName(workspace, meta.id);
  return {
    id: meta.id,
    ...(name ? { name } : {}),
    status: meta.status,
    mode: meta.mode,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(meta.usage ? { usage: meta.usage } : {}),
    ...(meta.plan ? { plan: meta.plan } : {}),
    task: meta.task,
  };
}

/** `sessions show <id> [--json]`. */
export function sessionsShowCommand(id: string, opts: { json?: boolean } = {}): void {
  const workspace = process.cwd();
  const meta = readSessionMeta(workspace, id);
  if (!meta) {
    fail(t("err.sessionNotFound", { id }), { hint: t("err.sessionNotFoundHint") });
    return;
  }
  const info = describeSession(workspace, meta);
  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const rows: [string, string | undefined][] = [
    ["cmd.sessions.showId", meta.id],
    ["cmd.sessions.showName", info.name as string | undefined],
    ["cmd.sessions.showStatus", `${meta.status} (${meta.mode})`],
    ["cmd.sessions.showCreated", meta.createdAt],
    ["cmd.sessions.showUpdated", meta.updatedAt],
    ["cmd.sessions.showParent", meta.parentAgentId],
    ["cmd.sessions.showMessages", info.messages === undefined ? undefined : String(info.messages)],
    ["cmd.sessions.showUsage", meta.usage ? formatUsage(meta.usage) : undefined],
  ];
  for (const [key, value] of rows) if (value !== undefined) console.log(`${t(key).padEnd(10)}${value}`);
  if (meta.plan && meta.plan.length > 0) {
    console.log(t("cmd.sessions.showPlan"));
    for (const item of meta.plan) {
      const box = item.status === "done" ? "☑" : item.status === "in_progress" ? "◐" : "☐";
      console.log(`  ${box} ${item.step}`);
    }
  }
  console.log(t("cmd.sessions.showTask"));
  console.log(meta.task);
  console.log("");
  console.log(t("cmd.sessions.showResumeHint", { id: meta.id }));
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
