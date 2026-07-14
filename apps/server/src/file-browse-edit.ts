import {
  constants,
  ftruncateSync,
  mkdirSync,
  readdirSync,
  readSync,
  writeSync,
  type Dirent,
} from "node:fs";
import { basename, dirname } from "node:path";
import { DEFAULT_IGNORE_DIRS, isSensitiveBasename } from "@seekforge/core";
import {
  closeVerifiedFile,
  FilePathChangedError,
  openVerifiedFile,
  revalidateOpenedFile,
  resolveWorkspacePath,
  type ResolvedWorkspacePath,
} from "./file-security.js";

export class FileBrowseError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileBrowseError";
  }
}

export const MAX_FILE_BYTES = 1_000_000;

export type TreeEntry = { name: string; path: string; type: "file" | "dir" };
export type Tree = { path: string; entries: TreeEntry[] };
export type FileView = { path: string; content: string; truncated: boolean };

function resolveBrowsePath(workspace: string, rel: string): ResolvedWorkspacePath {
  if (typeof rel !== "string" || rel.includes("\0")) {
    throw new FileBrowseError(400, "bad_request", "invalid path");
  }
  let resolved: ResolvedWorkspacePath;
  try {
    resolved = resolveWorkspacePath(workspace, rel, true);
  } catch (error) {
    const message =
      error instanceof FilePathChangedError
        ? "path contains a symbolic link"
        : "path escapes the workspace";
    throw new FileBrowseError(400, "bad_request", message);
  }

  const parts = resolved.relative === "" ? [] : resolved.relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === ".git" || DEFAULT_IGNORE_DIRS.has(part)) {
      throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
    }
    if (i < parts.length - 1 && part.startsWith(".")) {
      throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
    }
  }
  if (parts.length > 0 && isSensitiveBasename(parts[parts.length - 1]!)) {
    throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
  }
  return resolved;
}

export function listTree(workspace: string, rel: string): Tree {
  const resolved = resolveBrowsePath(workspace, rel);
  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved.path, constants.O_RDONLY);
  } catch (error) {
    if (error instanceof FilePathChangedError) {
      throw new FileBrowseError(400, "bad_request", "file path changed while opening");
    }
    throw new FileBrowseError(404, "not_found", "directory not found");
  }
  try {
    if (!opened.stat.isDirectory()) {
      throw new FileBrowseError(400, "bad_request", "path is not a directory");
    }
    let dirents: Dirent[];
    try {
      dirents = readdirSync(resolved.path, { withFileTypes: true });
      revalidateOpenedFile(resolved.path, opened);
    } catch (error) {
      if (error instanceof FilePathChangedError) {
        throw new FileBrowseError(400, "bad_request", "file path changed while reading directory");
      }
      throw new FileBrowseError(404, "not_found", "directory not readable");
    }
    const dirs: TreeEntry[] = [];
    const files: TreeEntry[] = [];
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      const childRel = resolved.relative === "" ? ent.name : `${resolved.relative}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
        dirs.push({ name: ent.name, path: childRel, type: "dir" });
      } else if (ent.isFile()) {
        if (isSensitiveBasename(ent.name)) continue;
        files.push({ name: ent.name, path: childRel, type: "file" });
      }
    }
    const byName = (a: TreeEntry, b: TreeEntry) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    dirs.sort(byName);
    files.sort(byName);
    return { path: resolved.relative, entries: [...dirs, ...files] };
  } finally {
    closeVerifiedFile(opened);
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

export function readTextFile(workspace: string, rel: string): FileView {
  const resolved = resolveBrowsePath(workspace, rel);
  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved.path, constants.O_RDONLY);
  } catch (error) {
    if (error instanceof FilePathChangedError) {
      throw new FileBrowseError(400, "bad_request", "file path changed while opening");
    }
    throw new FileBrowseError(404, "not_found", "file not found");
  }
  try {
    if (!opened.stat.isFile()) {
      throw new FileBrowseError(400, "bad_request", "path is not a file");
    }
    const truncated = opened.stat.size > MAX_FILE_BYTES;
    const length = Math.min(opened.stat.size, MAX_FILE_BYTES);
    const buf = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = readSync(opened.fileFd, buf, bytesRead, length - bytesRead, bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
    const content = buf.subarray(0, bytesRead);
    if (looksBinary(content)) {
      throw new FileBrowseError(400, "bad_request", "file is binary, not text");
    }
    return {
      path: resolved.relative,
      content: content.toString("utf8"),
      truncated,
    };
  } finally {
    closeVerifiedFile(opened);
  }
}

export function writeTextFile(workspace: string, rel: string, content: string): void {
  let resolved = resolveBrowsePath(workspace, rel);
  if (basename(resolved.path) === "" || resolved.relative === "") {
    throw new FileBrowseError(400, "bad_request", "invalid file path");
  }
  mkdirSync(dirname(resolved.path), { recursive: true });
  try {
    resolved = resolveWorkspacePath(workspace, rel, true);
  } catch {
    throw new FileBrowseError(400, "bad_request", "file path changed while opening");
  }

  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved.path, constants.O_WRONLY | constants.O_CREAT);
  } catch (error) {
    if (error instanceof FilePathChangedError) {
      throw new FileBrowseError(400, "bad_request", "file path changed while opening");
    }
    throw new FileBrowseError(400, "bad_request", "file not writable");
  }
  try {
    if (!opened.stat.isFile()) {
      throw new FileBrowseError(400, "bad_request", "path is not a file");
    }
    const data = Buffer.from(content, "utf8");
    ftruncateSync(opened.fileFd, 0);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(opened.fileFd, data, offset, data.length - offset, offset);
      if (written === 0) {
        throw new FileBrowseError(500, "write_failed", "file write made no progress");
      }
      offset += written;
    }
  } finally {
    closeVerifiedFile(opened);
  }
}
