import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveForWrite } from "../tools/sandbox.js";
import { isSafeLoopDagRelativePath } from "./loop-dag-validation.js";
import { readEngineeringGraphRunSnapshots } from "./graph-run-history.js";
import { listEngineeringGraphStates } from "./graph-state.js";
import { acquireSessionLease } from "./session-lease.js";

export const MAX_GRAPH_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const PUBLICATION_GRACE_MS = 5 * 60_000;

function assertDigestAndSize(sha256: string, sizeBytes: number): void {
  if (!DIGEST_RE.test(sha256)) throw new Error("Graph artifact digest is invalid");
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_GRAPH_ARTIFACT_BYTES) {
    throw new RangeError(`Graph artifact size must be from 0 to ${MAX_GRAPH_ARTIFACT_BYTES} bytes`);
  }
}

function ensurePhysicalDirectory(root: string, parts: readonly string[]): string {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(current) !== current) {
      throw new Error("Graph artifact store must use physical directories");
    }
  }
  return current;
}

function blobPath(workspace: string, sha256: string, createParents: boolean): string {
  if (!DIGEST_RE.test(sha256)) throw new Error("Graph artifact digest is invalid");
  const root = realpathSync.native(resolve(workspace));
  const parts = [".seekforge", "artifacts", "sha256", sha256.slice(0, 2)];
  const parent = createParents ? ensurePhysicalDirectory(root, parts) : join(root, ...parts);
  if (!createParents) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync.native(parent) !== parent) {
      return join(parent, sha256);
    }
  }
  return join(parent, sha256);
}

function hashPhysicalFile(path: string, expectedSize?: number): { sha256: string; sizeBytes: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Graph artifact blob must be a physical file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Graph artifact changed while opening");
    }
    if (opened.size > MAX_GRAPH_ARTIFACT_BYTES || (expectedSize !== undefined && opened.size !== expectedSize)) {
      throw new Error("Graph artifact size does not match its verified metadata");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      after.size !== opened.size ||
      position !== opened.size ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error("Graph artifact changed while hashing");
    }
    return { sha256: hash.digest("hex"), sizeBytes: position };
  } finally {
    closeSync(fd);
  }
}

function verifyBlob(path: string, sha256: string, sizeBytes: number): void {
  const actual = hashPhysicalFile(path, sizeBytes);
  if (actual.sha256 !== sha256) throw new Error("Graph artifact store digest mismatch");
}

function refreshBlobPublicationAge(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Graph artifact blob must be a physical file");
    const now = new Date();
    futimesSync(fd, now, now);
  } finally {
    closeSync(fd);
  }
}

/** Copies a verified artifact into immutable content-addressed storage and verifies it again. */
function storeEngineeringGraphArtifactUnlocked(
  workspace: string,
  sourcePath: string,
  sha256: string,
  sizeBytes: number,
): string {
  assertDigestAndSize(sha256, sizeBytes);
  const root = realpathSync.native(resolve(workspace));
  const requestedSource = resolve(sourcePath);
  const requestedSourceStat = lstatSync(requestedSource);
  if (!requestedSourceStat.isFile() || requestedSourceStat.isSymbolicLink()) {
    throw new Error("Graph artifact source is not a physical file");
  }
  const source = realpathSync.native(requestedSource);
  if (source !== root && !source.startsWith(`${root}${sep}`)) {
    throw new Error("Graph artifact source escapes its physical workspace");
  }
  const target = blobPath(workspace, sha256, true);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing) {
    verifyBlob(target, sha256, sizeBytes);
    refreshBlobPublicationAge(target);
    return target;
  }
  const parent = dirname(target);
  const temp = join(parent, `.${randomUUID()}.tmp`);
  const sourceBefore = lstatSync(source);
  if (
    !sourceBefore.isFile() ||
    sourceBefore.isSymbolicLink() ||
    sourceBefore.dev !== requestedSourceStat.dev ||
    sourceBefore.ino !== requestedSourceStat.ino
  )
    throw new Error("Graph artifact source is not a physical file");
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const targetFd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let completed = false;
  try {
    const opened = fstatSync(sourceFd);
    if (opened.dev !== sourceBefore.dev || opened.ino !== sourceBefore.ino || opened.size !== sizeBytes) {
      throw new Error("Graph artifact changed before content-addressed storage");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) written += writeSync(targetFd, buffer, written, bytesRead - written);
      position += bytesRead;
    }
    const sourceAfter = fstatSync(sourceFd);
    const current = lstatSync(source);
    if (
      position !== sizeBytes ||
      hash.digest("hex") !== sha256 ||
      sourceAfter.size !== opened.size ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error("Graph artifact changed during content-addressed storage");
    }
    fsyncSync(targetFd);
    closeSync(targetFd);
    closeSync(sourceFd);
    verifyBlob(temp, sha256, sizeBytes);
    renameSync(temp, target);
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    completed = true;
    return target;
  } finally {
    if (!completed) {
      try {
        closeSync(targetFd);
      } catch {
        // The descriptor may already have been closed after a successful copy.
      }
      try {
        closeSync(sourceFd);
      } catch {
        // The descriptor may already have been closed after a successful copy.
      }
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup of one exact transaction temporary file.
      }
    }
  }
}

export function storeEngineeringGraphArtifact(
  workspace: string,
  sourcePath: string,
  sha256: string,
  sizeBytes: number,
): string {
  const lease = acquireSessionLease(workspace, "graph-artifact-store");
  try {
    return storeEngineeringGraphArtifactUnlocked(workspace, sourcePath, sha256, sizeBytes);
  } finally {
    lease.release();
  }
}

export function engineeringGraphArtifactAvailable(workspace: string, sha256: string, sizeBytes: number): boolean {
  try {
    assertDigestAndSize(sha256, sizeBytes);
    verifyBlob(blobPath(workspace, sha256, false), sha256, sizeBytes);
    return true;
  } catch {
    return false;
  }
}

/** Materializes one immutable blob through a sibling temporary file and atomic rename. */
function materializeEngineeringGraphArtifactUnlocked(
  workspace: string,
  sha256: string,
  sizeBytes: number,
  targetPath: string,
  options: { overwrite?: boolean } = {},
): { path: string; sha256: string; sizeBytes: number } {
  assertDigestAndSize(sha256, sizeBytes);
  if (!isSafeLoopDagRelativePath(targetPath)) throw new Error("Graph artifact target path is invalid");
  const source = blobPath(workspace, sha256, false);
  verifyBlob(source, sha256, sizeBytes);
  const target = resolveForWrite(workspace, targetPath);
  const root = realpathSync.native(resolve(workspace));
  const relParent = relative(root, dirname(target));
  if (relParent === "" || (!relParent.startsWith(`..${sep}`) && relParent !== "..")) {
    ensurePhysicalDirectory(root, relParent === "" ? [] : relParent.split(sep));
  } else throw new Error("Graph artifact target escapes its workspace");
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && !options.overwrite) throw new Error(`Graph artifact target already exists: ${targetPath}`);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Graph artifact target must be a physical file: ${targetPath}`);
  }
  const temp = join(dirname(target), `.${randomUUID()}.tmp`);
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const targetFd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let completed = false;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) written += writeSync(targetFd, buffer, written, bytesRead - written);
      position += bytesRead;
    }
    if (position !== sizeBytes) throw new Error("Graph artifact blob changed during materialization");
    fsyncSync(targetFd);
    closeSync(targetFd);
    closeSync(sourceFd);
    verifyBlob(temp, sha256, sizeBytes);
    if (options.overwrite) {
      renameSync(temp, target);
    } else {
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Graph artifact target already exists: ${targetPath}`);
        }
        throw error;
      }
      try {
        unlinkSync(temp);
      } catch {
        // The published hard link remains authoritative if exact temporary cleanup fails.
      }
    }
    const parentFd = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    completed = true;
    return { path: targetPath, sha256, sizeBytes };
  } finally {
    if (!completed) {
      try {
        closeSync(targetFd);
      } catch {
        // Descriptor may already be closed.
      }
      try {
        closeSync(sourceFd);
      } catch {
        // Descriptor may already be closed.
      }
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup of one exact temporary file.
      }
    }
  }
}

export function materializeEngineeringGraphArtifact(
  workspace: string,
  sha256: string,
  sizeBytes: number,
  targetPath: string,
  options: { overwrite?: boolean } = {},
): { path: string; sha256: string; sizeBytes: number } {
  const lease = acquireSessionLease(workspace, "graph-artifact-store");
  try {
    return materializeEngineeringGraphArtifactUnlocked(workspace, sha256, sizeBytes, targetPath, options);
  } finally {
    lease.release();
  }
}

export type EngineeringGraphArtifactStoreEntry = {
  sha256: string;
  sizeBytes: number;
  modifiedAt: string;
  referenced: boolean;
};

export type EngineeringGraphArtifactPruneResult = {
  beforeBytes: number;
  afterBytes: number;
  retained: string[];
  candidates: string[];
  removed: string[];
};

function referencedArtifactDigests(workspace: string): Set<string> {
  const retained = new Set<string>();
  for (const state of listEngineeringGraphStates(workspace, { requireComplete: true })) {
    for (const result of state.results) {
      for (const artifact of result.artifacts ?? [])
        if (artifact.verified && artifact.sha256) retained.add(artifact.sha256);
    }
    for (const run of readEngineeringGraphRunSnapshots(workspace, state.graphId)) {
      for (const result of run.results) {
        for (const artifact of result.artifacts ?? [])
          if (artifact.verified && artifact.sha256) retained.add(artifact.sha256);
      }
    }
  }
  return retained;
}

export function inspectEngineeringGraphArtifactStore(workspace: string): EngineeringGraphArtifactStoreEntry[] {
  const root = realpathSync.native(resolve(workspace));
  const store = join(root, ".seekforge", "artifacts", "sha256");
  const referenced = referencedArtifactDigests(root);
  const entries: EngineeringGraphArtifactStoreEntry[] = [];
  let prefixes: Dirent<string>[];
  try {
    prefixes = readdirSync(store, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (prefixes.length > 512) throw new Error("Graph artifact store has too many prefix entries");
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || prefix.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    const directory = join(store, prefix.name);
    if (realpathSync.native(directory) !== directory) continue;
    const files = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    if (files.length > 4_096) throw new Error(`Graph artifact prefix has too many entries: ${prefix.name}`);
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !DIGEST_RE.test(file.name) || !file.name.startsWith(prefix.name))
        continue;
      const path = join(directory, file.name);
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_GRAPH_ARTIFACT_BYTES ||
        realpathSync.native(path) !== path
      ) {
        continue;
      }
      entries.push({
        sha256: file.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        referenced: referenced.has(file.name),
      });
    }
  }
  return entries.sort(
    (left, right) =>
      Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt) || left.sha256.localeCompare(right.sha256),
  );
}

/** Removes only exact, unreferenced CAS blobs selected by age or the configured store quota. */
function pruneEngineeringGraphArtifactStoreUnlocked(
  workspace: string,
  options: { maxBytes?: number; maxAgeDays?: number; dryRun?: boolean; now?: Date } = {},
): EngineeringGraphArtifactPruneResult {
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
  const maxAgeDays = options.maxAgeDays ?? 30;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Graph artifact store maxBytes is invalid");
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 3_650) {
    throw new RangeError("Graph artifact store maxAgeDays must be an integer from 0 to 3650");
  }
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph artifact prune time is invalid");
  const entries = inspectEngineeringGraphArtifactStore(workspace);
  const beforeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  let projectedBytes = beforeBytes;
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.referenced) continue;
    const ageMs = Math.max(0, nowMs - Date.parse(entry.modifiedAt));
    if (ageMs < PUBLICATION_GRACE_MS) continue;
    if (projectedBytes > maxBytes || ageMs >= maxAgeDays * 24 * 60 * 60_000) {
      candidates.push(entry.sha256);
      projectedBytes -= entry.sizeBytes;
    }
  }
  const removed: string[] = [];
  if (!options.dryRun) {
    for (const sha256 of candidates) {
      const entry = entries.find((candidate) => candidate.sha256 === sha256)!;
      const path = blobPath(workspace, sha256, false);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (
        !stat?.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== entry.sizeBytes ||
        realpathSync.native(path) !== path
      ) {
        continue;
      }
      unlinkSync(path);
      removed.push(sha256);
    }
  }
  const removedBytes = entries
    .filter((entry) => removed.includes(entry.sha256))
    .reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    beforeBytes,
    afterBytes: options.dryRun ? projectedBytes : beforeBytes - removedBytes,
    retained: entries
      .filter((entry) => !(options.dryRun ? candidates : removed).includes(entry.sha256))
      .map((entry) => entry.sha256),
    candidates,
    removed,
  };
}

export function pruneEngineeringGraphArtifactStore(
  workspace: string,
  options: { maxBytes?: number; maxAgeDays?: number; dryRun?: boolean; now?: Date } = {},
): EngineeringGraphArtifactPruneResult {
  const lease = acquireSessionLease(workspace, "graph-artifact-store");
  try {
    return pruneEngineeringGraphArtifactStoreUnlocked(workspace, options);
  } finally {
    lease.release();
  }
}
