import { randomBytes } from "node:crypto";
import {
  constants,
  mkdirSync,
  readSync,
  writeSync,
} from "node:fs";
import { extname } from "node:path";
import {
  closeVerifiedFile,
  FilePathChangedError,
  isPathInside,
  openVerifiedFile,
  resolveWorkspacePath,
} from "./file-security.js";

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
export const MAX_UPLOAD_BYTES = 4_000_000;
export const MAX_RAW_BYTES = 8_000_000;

const RAW_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const UPLOADS_DIR = ".seekforge/uploads";
const UPLOADS_PREFIX = `${UPLOADS_DIR}/`;

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

function decodeBase64(value: string): Buffer | null {
  let encoded = value;
  if (/^data:/i.test(value)) {
    const match = /^data:[^,]*;base64,(.*)$/is.exec(value);
    if (!match) return null;
    encoded = match[1] ?? "";
  }
  if (encoded === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  const firstPadding = encoded.indexOf("=");
  if (firstPadding !== -1 && encoded.length % 4 !== 0) return null;
  const data = Buffer.from(encoded, "base64");
  const canonical = data.toString("base64").replace(/=+$/, "");
  return canonical === encoded.replace(/=+$/, "") ? data : null;
}

function resolveUploadPath(root: string, rel: string): string {
  try {
    return resolveWorkspacePath(root, rel, true).path;
  } catch {
    throw new UploadError(400, "bad_request", "upload path escapes the workspace");
  }
}

export function saveUpload(root: string, name: string, dataBase64: string): { path: string } {
  const ext = extname(name).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new UploadError(
      400,
      "bad_request",
      `unsupported image extension ".${ext}" — supported: ${[...IMAGE_EXTENSIONS].join(", ")}`,
    );
  }
  const data = decodeBase64(dataBase64);
  if (!data || data.length === 0) {
    throw new UploadError(400, "bad_request", "dataBase64 is empty or not valid base64");
  }
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, "too_large", `image exceeds ${MAX_UPLOAD_BYTES} bytes after decoding`);
  }

  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const rel = `${UPLOADS_PREFIX}img-${stamp}.${ext}`;
  let opened: ReturnType<typeof openVerifiedFile> | undefined;
  try {
    const uploadDir = resolveUploadPath(root, UPLOADS_DIR);
    mkdirSync(uploadDir, { recursive: true });
    const target = resolveUploadPath(root, rel);
    opened = openVerifiedFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(opened.fileFd, data, offset, data.length - offset, offset);
      if (written === 0) throw new Error("upload write made no progress");
      offset += written;
    }
  } catch (error) {
    if (error instanceof FilePathChangedError) {
      throw new UploadError(400, "bad_request", "upload path escapes the workspace");
    }
    throw error;
  } finally {
    if (opened) closeVerifiedFile(opened);
  }
  return { path: rel };
}

export class RawFileError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RawFileError";
  }
}

export function readRawUpload(root: string, path: string): { data: Buffer; contentType: string } {
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    throw new RawFileError(400, "bad_request", "path is required");
  }

  let resolved: ReturnType<typeof resolveWorkspacePath>;
  let uploadDir: ReturnType<typeof resolveWorkspacePath>;
  try {
    resolved = resolveWorkspacePath(root, path, true);
    uploadDir = resolveWorkspacePath(root, UPLOADS_DIR, true);
  } catch {
    throw new RawFileError(400, "bad_request", "path escapes the workspace");
  }
  if (!resolved.requestedRelative.startsWith(UPLOADS_PREFIX)) {
    throw new RawFileError(400, "bad_request", `path must be under ${UPLOADS_PREFIX}`);
  }
  if (!isPathInside(uploadDir.path, resolved.path)) {
    throw new RawFileError(400, "bad_request", "path escapes the uploads directory");
  }

  const ext = extname(resolved.requestedRelative).slice(1).toLowerCase();
  const contentType = RAW_CONTENT_TYPES[ext];
  if (!contentType) {
    throw new RawFileError(
      415,
      "unsupported_media_type",
      `unsupported image extension ".${ext}" — supported: ${Object.keys(RAW_CONTENT_TYPES).join(", ")}`,
    );
  }

  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved.path, constants.O_RDONLY);
  } catch (error) {
    if (error instanceof FilePathChangedError) {
      throw new RawFileError(400, "bad_request", "path escapes the uploads directory");
    }
    throw new RawFileError(404, "not_found", "file not found");
  }
  try {
    if (!opened.stat.isFile()) throw new RawFileError(404, "not_found", "file not found");
    if (opened.stat.size > MAX_RAW_BYTES) {
      throw new RawFileError(413, "too_large", `file exceeds ${MAX_RAW_BYTES} bytes`);
    }
    const data = Buffer.allocUnsafe(opened.stat.size);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const read = readSync(opened.fileFd, data, bytesRead, data.length - bytesRead, bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
    return { data: data.subarray(0, bytesRead), contentType };
  } finally {
    closeVerifiedFile(opened);
  }
}
