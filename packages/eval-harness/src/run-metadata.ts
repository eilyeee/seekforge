import { createHash, type Hash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { platform, release } from "node:os";
import { join, relative } from "node:path";
import type { EvalConfig } from "./config.js";
import { DEFAULT_MODEL } from "@seekforge/core";
import { repoRoot, tasksDir } from "./paths.js";
import type { TaskDef } from "./tasks.js";
import { MAX_DATASET_FILES, MAX_DATASET_FILE_BYTES, MAX_DATASET_TOTAL_BYTES } from "./limits.js";

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
  const pending = [dir];
  let discovered = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries: string[] = [];
    const handle = opendirSync(current);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        discovered += 1;
        if (discovered > MAX_DATASET_FILES) throw new Error(`dataset exceeds ${MAX_DATASET_FILES} entries`);
        entries.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    for (const entry of entries.sort().reverse()) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) {
        files.push(path);
        if (files.length > MAX_DATASET_FILES) throw new Error(`dataset exceeds ${MAX_DATASET_FILES} files`);
      }
    }
  }
  return files.sort();
}

function hashFile(hash: Hash, path: string, consumed: { bytes: number }): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`dataset path is not a regular file: ${path}`);
    if (stat.size > MAX_DATASET_FILE_BYTES)
      throw new Error(`dataset file exceeds ${MAX_DATASET_FILE_BYTES} bytes: ${path}`);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let fileBytes = 0;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      fileBytes += bytesRead;
      consumed.bytes += bytesRead;
      if (fileBytes > MAX_DATASET_FILE_BYTES) {
        throw new Error(`dataset file grew beyond ${MAX_DATASET_FILE_BYTES} bytes: ${path}`);
      }
      if (consumed.bytes > MAX_DATASET_TOTAL_BYTES) {
        throw new Error(`dataset exceeds ${MAX_DATASET_TOTAL_BYTES} total bytes`);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function hashDataset(tasks: TaskDef[], fixtureRoot: string): string {
  const hash = createHash("sha256");
  const consumed = { bytes: 0 };
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const taskFile = join(tasksDir, `${task.id}.json`);
    hash.update(`task:${task.id}\0`);
    try {
      hashFile(hash, taskFile, consumed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(JSON.stringify(task));
    }
    const fixtureDir = join(fixtureRoot, task.fixture);
    for (const file of filesUnder(fixtureDir)) {
      hash.update(`fixture:${task.fixture}/${relative(fixtureDir, file)}\0`);
      hashFile(hash, file, consumed);
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
