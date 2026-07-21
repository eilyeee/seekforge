/**
 * Clipboard image capture (Ctrl+V image paste). Clipboard bytes are captured
 * into process-owned memory/private temp storage, then persisted beneath a
 * physically verified workspace with an exclusive final link.
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { readBufferFileBounded } from "./bounded-file.js";

export type CapturedImage = {
  /** Workspace-relative path (always "/" separators) under .seekforge/uploads/. */
  path: string;
};

const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** AppleScript that writes the clipboard PNG to a private temporary file. */
function darwinScript(abs: string): string {
  return [
    `set p to POSIX file "${appleScriptString(abs)}"`,
    "set f to open for access p with write permission",
    "try",
    "  write (the clipboard as «class PNGf») to f",
    "on error",
    "  close access f",
    "  error",
    "end try",
    "close access f",
  ].join("\n");
}

/** img-<yyyymmdd-hhmmss>-<128-bit random>.png */
function uploadName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `img-${stamp}-${randomBytes(16).toString("hex")}.png`;
}

function captureDarwinBytes(): Buffer | null {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "seekforge-clipboard-"));
  const file = path.join(dir, "clipboard.png");
  try {
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.closeSync(fd);
    const args = darwinScript(file)
      .split("\n")
      .flatMap((line) => ["-e", line]);
    const result = spawnSync("osascript", args);
    if (result.error || result.status !== 0) return null;
    const bytes = readBufferFileBounded(file, MAX_CLIPBOARD_IMAGE_BYTES);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LINUX_CANDIDATES: Array<[string, string[]]> = [
  ["wl-paste", ["--type", "image/png"]],
  ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
];

function captureLinuxBytes(): Buffer | null {
  for (const [cmd, args] of LINUX_CANDIDATES) {
    try {
      const result = spawnSync(cmd, args, { maxBuffer: MAX_CLIPBOARD_IMAGE_BYTES });
      if (result.error || result.status !== 0) continue;
      const bytes = result.stdout as Buffer | null;
      if (bytes && bytes.length > 0 && bytes.length <= MAX_CLIPBOARD_IMAGE_BYTES) return bytes;
    } catch {
      // Keep trying the next candidate.
    }
  }
  return null;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ensurePlainChild(parent: string, name: string): string {
  const child = path.join(parent, name);
  try {
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe upload directory: ${child}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(child, { mode: 0o700 });
  }
  if (fs.realpathSync(child) !== child) throw new Error(`upload directory escaped workspace: ${child}`);
  return child;
}

function verifyDirectory(dir: string, fd: number): void {
  const opened = fs.fstatSync(fd);
  const current = fs.lstatSync(dir);
  if (
    !opened.isDirectory() ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    fs.realpathSync(dir) !== dir ||
    !sameIdentity(opened, fs.statSync(dir))
  ) {
    throw new Error(`upload directory changed while open: ${dir}`);
  }
}

/** Persist already-captured bytes without following or replacing any leaf. */
export function saveClipboardImage(workspace: string, bytes: Buffer, name = uploadName()): CapturedImage | null {
  if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) return null;
  if (path.basename(name) !== name || !/^img-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}\.png$/.test(name)) return null;

  let dirFd: number | undefined;
  let temp: string | undefined;
  try {
    const root = fs.realpathSync(path.resolve(workspace));
    const stateDir = ensurePlainChild(root, ".seekforge");
    const uploadsDir = ensurePlainChild(stateDir, "uploads");
    dirFd = fs.openSync(
      uploadsDir,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    verifyDirectory(uploadsDir, dirFd);

    temp = path.join(uploadsDir, `.upload-${randomBytes(16).toString("hex")}.tmp`);
    const fileFd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(fileFd, bytes);
      fs.fsyncSync(fileFd);
    } finally {
      fs.closeSync(fileFd);
    }

    verifyDirectory(uploadsDir, dirFd);
    const dest = path.join(uploadsDir, name);
    if (fs.lstatSync(dest, { throwIfNoEntry: false }) !== undefined) return null;
    fs.linkSync(temp, dest);
    fs.unlinkSync(temp);
    temp = undefined;
    fs.fsyncSync(dirFd);
    return { path: `.seekforge/uploads/${name}` };
  } catch {
    return null;
  } finally {
    if (temp) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The verified directory may have changed; never chase cleanup elsewhere.
      }
    }
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
}

/** Captures and persists one clipboard image. Never throws. */
export function captureClipboardImage(workspace: string, platform?: string): CapturedImage | null {
  const plat = platform ?? process.platform;
  const bytes = plat === "darwin" ? captureDarwinBytes() : plat === "linux" ? captureLinuxBytes() : null;
  return bytes ? saveClipboardImage(workspace, bytes) : null;
}

/** Marker inserted into the composer text: "[image #N: path]". */
export function imagePlaceholder(index: number, imagePath: string): string {
  return `[image #${index}: ${imagePath}]`;
}

const IMAGE_MARKER = /\[image #\d+: ([^\]]+)\]/g;

/** Extract every path embedded in image markers, in order. */
export function extractImagePaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMAGE_MARKER)) out.push((match[1] as string).trim());
  return out;
}
