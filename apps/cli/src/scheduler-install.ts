import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type SchedulerInstallPlan = {
  id: string;
  workspace: string;
  command: string;
  installed: boolean;
};

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function plan(projectPath: string): SchedulerInstallPlan {
  const workspace = realpathSync(projectPath);
  const id = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
  const argv1 = process.argv[1];
  const executable = argv1
    ? [process.execPath, ...(argv1.endsWith(".ts") ? process.execArgv : []), argv1]
    : [];
  const invoke = executable.length > 0
    ? `${executable.map(quote).join(" ")} schedule run --json`
    : "seekforge schedule run --json";
  const command = `* * * * * cd ${quote(workspace)} && ${invoke}`;
  return { id, workspace, command, installed: false };
}

function readCrontab(missingOk = false): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    if (missingOk) return "";
    throw new Error("crontab was not found on PATH");
  }
  if (result.status !== 0 && !/no crontab/i.test(result.stderr ?? "")) {
    throw new Error((result.stderr ?? "could not read crontab").trim());
  }
  return result.status === 0 ? result.stdout ?? "" : "";
}

function markers(id: string): { begin: string; end: string } {
  return { begin: `# seekforge:${id}:begin`, end: `# seekforge:${id}:end` };
}

function removeBlock(crontab: string, id: string): string {
  const { begin, end } = markers(id);
  const lines = crontab.split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === begin) {
      inside = true;
      continue;
    }
    if (inside && line === end) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

function writeCrontab(value: string): void {
  const result = spawnSync("crontab", ["-"], { input: value === "" ? "" : `${value}\n`, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr ?? "could not update crontab").trim());
}

export function schedulerStatus(projectPath: string): SchedulerInstallPlan {
  const result = plan(projectPath);
  const { begin, end } = markers(result.id);
  const crontab = readCrontab();
  return { ...result, installed: crontab.split("\n").includes(begin) && crontab.split("\n").includes(end) };
}

export function installScheduler(projectPath: string, dryRun = false): SchedulerInstallPlan {
  const result = plan(projectPath);
  const current = readCrontab(dryRun);
  const clean = removeBlock(current, result.id);
  const { begin, end } = markers(result.id);
  const next = [clean, begin, result.command, end].filter(Boolean).join("\n");
  if (!dryRun) writeCrontab(next);
  return { ...result, installed: !dryRun };
}

export function uninstallScheduler(projectPath: string, dryRun = false): SchedulerInstallPlan {
  const result = plan(projectPath);
  const current = readCrontab(dryRun);
  const installed = removeBlock(current, result.id) !== current.replace(/^\n+|\n+$/g, "");
  if (!dryRun && installed) writeCrontab(removeBlock(current, result.id));
  return { ...result, installed: false };
}
