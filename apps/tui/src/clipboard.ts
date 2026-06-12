/**
 * Best-effort clipboard copy. Tries the platform's clipboard binaries in
 * order; the first one that exists and succeeds wins. Never throws.
 */
import { spawnSync } from "node:child_process";

const DARWIN: Array<[string, string[]]> = [["pbcopy", []]];
const OTHER: Array<[string, string[]]> = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
];

/** Copy `text` to the system clipboard. Returns false when no binary worked. */
export function copyToClipboard(text: string): boolean {
  const candidates = process.platform === "darwin" ? DARWIN : OTHER;
  for (const [cmd, args] of candidates) {
    try {
      const r = spawnSync(cmd, args, { input: text });
      if (!r.error && r.status === 0) return true;
    } catch {
      // keep trying the next candidate
    }
  }
  return false;
}
