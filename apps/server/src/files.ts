/**
 * Workspace file index + image uploads for the web composer (SERVER-API.md):
 * GET /api/files (the @ file picker) and POST /api/upload (image paste/drop).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { extname, join } from "node:path";
import { DEFAULT_IGNORE_DIRS } from "@seekforge/core";

/** Hard cap on the number of paths GET /api/files returns. */
export const FILE_LIST_LIMIT = 2000;

/** Extensions accepted by POST /api/upload (what core image_analyze supports). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Decoded size cap for uploads (matches core image_analyze's 4MB limit). */
export const MAX_UPLOAD_BYTES = 4_000_000;

export type FileList = { files: string[]; truncated: boolean };

/**
 * BFS over the workspace (shallow files first — the likeliest @-targets),
 * returning workspace-relative paths with "/" separators. Skips
 * DEFAULT_IGNORE_DIRS members, dot-directories, and symlinks. `q` is a
 * case-insensitive substring filter on the relative path, applied while
 * scanning so deep matches are still found in large repos. `truncated` is
 * true when the limit cut the scan short.
 */
export function listWorkspaceFiles(root: string, q = "", limit = FILE_LIST_LIMIT): FileList {
  const needle = q.toLowerCase();
  const files: string[] = [];
  const queue: string[] = [""]; // workspace-relative directories
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(childRel);
      } else if (entry.isFile()) {
        if (needle !== "" && !childRel.toLowerCase().includes(needle)) continue;
        if (files.length >= limit) return { files, truncated: true };
        files.push(childRel);
      }
    }
  }
  return { files, truncated: false };
}

/** Upload validation failure carrying the HTTP status/code to respond with. */
export class UploadError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Validates and saves an uploaded image (base64 JSON body) under
 * `.seekforge/uploads/img-<stamp>.<ext>`. Only the extension of `name` is
 * used — the client filename never reaches the disk path. Returns the
 * workspace-relative path (what core image_analyze consumes).
 */
export function saveUpload(root: string, name: string, dataBase64: string): { path: string } {
  const ext = extname(name).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new UploadError(
      400,
      "bad_request",
      `unsupported image extension ".${ext}" — supported: ${[...IMAGE_EXTENSIONS].join(", ")}`,
    );
  }
  // Tolerate a data-URL prefix ("data:image/png;base64,....").
  const b64 = dataBase64.replace(/^data:[^,]*,/, "");
  const data = Buffer.from(b64, "base64");
  if (data.length === 0) {
    throw new UploadError(400, "bad_request", "dataBase64 is empty or not valid base64");
  }
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, "too_large", `image exceeds ${MAX_UPLOAD_BYTES} bytes after decoding`);
  }
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const rel = `.seekforge/uploads/img-${stamp}.${ext}`;
  mkdirSync(join(root, ".seekforge", "uploads"), { recursive: true });
  writeFileSync(join(root, rel), data);
  return { path: rel };
}
