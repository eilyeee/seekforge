import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join, relative } from "node:path";
import type { EvalConfig } from "./config.js";
import { DEFAULT_MODEL } from "@seekforge/core";
import { repoRoot, tasksDir } from "./paths.js";
import type { TaskDef } from "./tasks.js";

export type RunMetadata = {
  provider: string;
  model: string;
  variant: string;
  suite?: string;
  repeat: number;
  gitSha: string | null;
  datasetHash: string;
  node: string;
  platform: string;
};

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...filesUnder(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

export function hashDataset(tasks: TaskDef[], fixtureRoot: string): string {
  const hash = createHash("sha256");
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const taskFile = join(tasksDir, `${task.id}.json`);
    hash.update(`task:${task.id}\0`);
    try {
      hash.update(readFileSync(taskFile));
    } catch {
      hash.update(JSON.stringify(task));
    }
    const fixtureDir = join(fixtureRoot, task.fixture);
    for (const file of filesUnder(fixtureDir)) {
      hash.update(`fixture:${task.fixture}/${relative(fixtureDir, file)}\0`);
      hash.update(readFileSync(file));
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function createRunMetadata(input: {
  config: EvalConfig;
  variant: string;
  suite?: string;
  repeat: number;
  tasks: TaskDef[];
  fixtureRoot: string;
  modelOverride?: string;
}): RunMetadata {
  const metadata: RunMetadata = {
    provider: input.config.provider ?? "deepseek",
    model: input.modelOverride ?? input.config.model ?? DEFAULT_MODEL,
    variant: input.variant,
    repeat: input.repeat,
    gitSha: gitSha(),
    datasetHash: hashDataset(input.tasks, input.fixtureRoot),
    node: process.version,
    platform: `${platform()} ${release()} ${process.arch}`,
  };
  if (input.suite !== undefined) metadata.suite = input.suite;
  return metadata;
}
