/**
 * Clipboard image capture (Ctrl+V image paste). Reads a PNG off the system
 * clipboard via osascript (darwin) or wl-paste/xclip (linux), saves it under
 * <workspace>/.seekforge/uploads/, and returns the workspace-relative path.
 * The composer inserts an "[image #N: path]" marker; extractImagePaths pulls
 * the paths back out at send time for a vision-capable provider. Never throws.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type CapturedImage = {
  /** Workspace-relative path (always "/" separators) under .seekforge/uploads/. */
  path: string;
};

/** AppleScript that writes the clipboard PNG to `abs`; errors when no image. */
function darwinScript(abs: string): string {
  return [
    `set p to POSIX file "${abs}"`,
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

/** img-<yyyymmdd-hhmmss>-<rand4>.png */
function uploadName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `img-${stamp}-${rand}.png`;
}

function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // best-effort cleanup
  }
}

/** darwin: osascript writes the clipboard PNG straight to `dest`. */
function captureDarwin(dest: string): boolean {
  try {
    const lines = darwinScript(dest).split("\n");
    const args = lines.flatMap((line) => ["-e", line]);
    const r = spawnSync("osascript", args);
    if (r.error || r.status !== 0) return false;
    return fs.existsSync(dest) && fs.statSync(dest).size > 0;
  } catch {
    return false;
  }
}

const LINUX_CANDIDATES: Array<[string, string[]]> = [
  ["wl-paste", ["--type", "image/png"]],
  ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
];

/** linux: first of wl-paste/xclip that yields PNG bytes on stdout wins. */
function captureLinux(dest: string): boolean {
  for (const [cmd, args] of LINUX_CANDIDATES) {
    try {
      const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
      if (r.error || r.status !== 0) continue;
      const buf = r.stdout as Buffer | null;
      if (!buf || buf.length === 0) continue;
      fs.writeFileSync(dest, buf);
      return true;
    } catch {
      // keep trying the next candidate
    }
  }
  return false;
}

/**
 * Captures the clipboard image into <workspace>/.seekforge/uploads/ and
 * returns the workspace-relative path, or null when the clipboard holds no
 * image (or the platform has no usable tool). Never throws.
 */
export function captureClipboardImage(workspace: string, platform?: string): CapturedImage | null {
  const plat = platform ?? process.platform;
  try {
    const dir = path.join(workspace, ".seekforge", "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const name = uploadName();
    const dest = path.join(dir, name);
    const ok =
      plat === "darwin" ? captureDarwin(dest) : plat === "linux" ? captureLinux(dest) : false;
    if (!ok) {
      tryUnlink(dest);
      return null;
    }
    return { path: `.seekforge/uploads/${name}` };
  } catch {
    return null;
  }
}

/** Marker inserted into the composer text: "[image #N: path]". */
export function imagePlaceholder(index: number, imagePath: string): string {
  return `[image #${index}: ${imagePath}]`;
}

const IMAGE_MARKER = /\[image #\d+: ([^\]]+)\]/g;

/**
 * Extracts every path embedded in "[image #N: …]" markers, in order. The
 * task text keeps the markers; a vision provider resolves these paths.
 */
export function extractImagePaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMAGE_MARKER)) {
    out.push((match[1] as string).trim());
  }
  return out;
}
