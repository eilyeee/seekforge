import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listSessions, pruneSessions } from "@seekforge/core";
import { loadConfig } from "../config.js";
import { formatUsage } from "../render.js";

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function sessionsCommand(): void {
  const sessions = listSessions(process.cwd());
  if (sessions.length === 0) {
    console.log("No sessions yet. Run `seekforge run \"<task>\"` to start one.");
    return;
  }
  for (const s of sessions) {
    const cost = s.usage ? ` $${s.usage.costUsd.toFixed(4)}` : "";
    console.log(`${s.id}  [${s.status}]${cost}  ${truncate(s.task, 60)}`);
  }
}

export type PruneOptions = { olderThan?: string; keepLast?: string; dryRun?: boolean };

export function sessionsPruneCommand(opts: PruneOptions): void {
  const olderThanDays = opts.olderThan !== undefined ? Number.parseInt(opts.olderThan, 10) : undefined;
  const keepLast = opts.keepLast !== undefined ? Number.parseInt(opts.keepLast, 10) : undefined;
  if (olderThanDays === undefined && keepLast === undefined) {
    console.error("Specify --older-than <days> and/or --keep-last <n> (use --dry-run to preview).");
    process.exitCode = 1;
    return;
  }
  if ((olderThanDays !== undefined && Number.isNaN(olderThanDays)) || (keepLast !== undefined && Number.isNaN(keepLast))) {
    console.error("--older-than and --keep-last must be numbers.");
    process.exitCode = 1;
    return;
  }
  const result = pruneSessions(process.cwd(), { olderThanDays, keepLast, dryRun: opts.dryRun });
  if (result.removed.length === 0) {
    console.log("Nothing to prune.");
    return;
  }
  const verb = opts.dryRun ? "would remove" : "removed";
  console.log(`${verb} ${result.removed.length} session(s); ${result.kept} kept.`);
  if (opts.dryRun) for (const id of result.removed) console.log(`  ${id}`);
}

export function statusCommand(): void {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const sessions = listSessions(projectPath);
  const last = sessions[0];

  console.log(`project:   ${projectPath}`);
  console.log(`config:    ${existsSync(join(projectPath, ".seekforge")) ? ".seekforge/ present" : "not initialized (run seekforge init)"}`);
  console.log(`api key:   ${config.apiKey ? `${config.apiKey.slice(0, 6)}**** ` : "MISSING"}`);
  console.log(`model:     ${config.model ?? "deepseek-v4-flash (default)"}`);
  console.log(`global:    ${join(homedir(), ".seekforge", "config.json")}`);
  console.log(`sessions:  ${sessions.length}`);
  if (last) {
    console.log(`last:      ${last.id} [${last.status}] ${truncate(last.task, 50)}`);
    if (last.usage) console.log(`           ${formatUsage(last.usage)}`);
  }
}
