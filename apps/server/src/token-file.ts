/**
 * The opt-in server token file (`seekforge serve --token-file <path>`).
 *
 * The bearer token is otherwise printed once, so only the process that started
 * the server can attach to it. A local client that did not start it (the VS Code
 * extension, a script) can read this file instead. It holds a live credential,
 * so it is written 0600 through a temporary file and a rename (a reader never
 * sees half a token, and a symlink planted at the path is replaced rather than
 * followed), and removed when the server closes — but only while it still holds
 * this server's token, so a later server writing the same path keeps its file.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ServerTokenFile = {
  version: 1;
  port: number;
  token: string;
  pid: number;
  /** The authenticated UI URL, as `seekforge serve` prints it. */
  url: string;
};

const MAX_TOKEN_FILE_BYTES = 4_096;

/** Writes the token file; returns the absolute path written. */
export function writeServerTokenFile(path: string, server: { port: number; token: string }): string {
  if (typeof path !== "string" || path.trim() === "") throw new Error("token file path must not be empty");
  const target = resolve(path);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(target).isDirectory()) throw new Error(`token file path is a directory: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content: ServerTokenFile = {
    version: 1,
    port: server.port,
    token: server.token,
    pid: process.pid,
    url: `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(server.token)}`,
  };
  const temp = join(dir, `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    // A umask cannot widen 0600, but a pre-existing inode's mode is irrelevant
    // after the rename; this only guards platforms that ignore the open mode.
    chmodSync(target, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The rename consumed it, or it was never created.
    }
  }
  return target;
}

/** Parses a token file; undefined when it is missing, oversized or malformed. */
export function readServerTokenFile(path: string): ServerTokenFile | undefined {
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) return undefined;
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServerTokenFile> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      typeof parsed.token !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string"
    ) {
      return undefined;
    }
    return parsed as ServerTokenFile;
  } catch {
    return undefined;
  }
}

/** Removes the token file if it still belongs to the server holding `token`. Synchronous (runs on 'exit'). */
export function removeServerTokenFile(path: string, token: string): void {
  if (readServerTokenFile(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}
