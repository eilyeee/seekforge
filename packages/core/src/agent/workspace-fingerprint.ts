import { createHash, type Hash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 20_000;
const FINGERPRINT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const INTERNAL_PREFIXES = [".seekforge/loops/", ".seekforge/memory/", ".seekforge/sessions/", ".seekforge/uploads/"];
const INTERNAL_FILES = new Set([".seekforge/skills-usage.jsonl"]);
const FALLBACK_IGNORES = new Set([".git", "node_modules", "dist", "build", "coverage", "target"]);

class FingerprintLimitError extends Error {}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_BYTES,
        timeout: FINGERPRINT_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function internalPath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return INTERNAL_FILES.has(normalized) || INTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

type Budget = { bytes: number; files: number; deadline: number };

function checkBudget(budget: Budget): void {
  if (budget.bytes > MAX_FINGERPRINT_BYTES || budget.files > MAX_FINGERPRINT_FILES || Date.now() > budget.deadline) {
    throw new FingerprintLimitError("workspace fingerprint budget exceeded");
  }
}

async function hashPath(hash: Hash, absolute: string, relative: string, budget: Budget): Promise<void> {
  checkBudget(budget);
  const before = await lstat(absolute);
  budget.files++;
  checkBudget(budget);
  hash.update(`\0${relative}\0${before.mode}\0${before.size}\0`);
  if (before.isSymbolicLink()) {
    hash.update(await readlink(absolute));
    return;
  }
  if (before.isDirectory()) {
    hash.update(await git(absolute, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]));
    return;
  }
  if (!before.isFile()) return;
  budget.bytes += before.size;
  checkBudget(budget);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`workspace file changed during fingerprint: ${relative}`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      checkBudget(budget);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function gitFingerprint(workspace: string, budget: Budget): Promise<string> {
  const hash = createHash("sha256");
  try {
    hash.update(await git(workspace, ["rev-parse", "--verify", "HEAD"]));
  } catch {
    hash.update("<unborn-head>");
  }
  const [status, ...pathOutputs] = await Promise.all([
    git(workspace, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    git(workspace, ["diff", "--name-only", "-z"]),
    git(workspace, ["diff", "--cached", "--name-only", "-z"]),
    git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = [...new Set(pathOutputs.flatMap((value) => value.split("\0")).filter(Boolean))]
    .filter((path) => !internalPath(path))
    .sort();
  const relevantStatus = status
    .split("\0")
    .filter(
      (record) =>
        !INTERNAL_PREFIXES.some((prefix) => record.includes(` ${prefix}`)) &&
        ![...INTERNAL_FILES].some((file) => record.includes(` ${file}`)),
    )
    .join("\0");
  hash.update(relevantStatus);
  for (const path of paths) {
    try {
      await hashPath(hash, join(workspace, path), path, budget);
    } catch (error) {
      if (error instanceof FingerprintLimitError) throw error;
      hash.update(`\0${path}\0<unreadable>`);
    }
  }
  return hash.digest("hex");
}

async function fallbackFingerprint(workspace: string, budget: Budget): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relative = ""): Promise<void> => {
    checkBudget(budget);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (FALLBACK_IGNORES.has(entry.name) || internalPath(`${path}/`)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile() || entry.isSymbolicLink()) await hashPath(hash, absolute, path, budget);
    }
  };
  await visit(workspace);
  return hash.digest("hex");
}

/** Bounded, non-blocking progress fingerprint. `null` disables convergence decisions for this sample. */
export async function workspaceFingerprint(workspace: string): Promise<string | null> {
  const budget: Budget = { bytes: 0, files: 0, deadline: Date.now() + FINGERPRINT_TIMEOUT_MS };
  try {
    return await gitFingerprint(workspace, budget);
  } catch (error) {
    if (error instanceof FingerprintLimitError) return null;
  }
  try {
    return await fallbackFingerprint(workspace, budget);
  } catch {
    return null;
  }
}
