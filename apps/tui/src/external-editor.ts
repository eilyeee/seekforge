/**
 * $EDITOR round-trip for long prompts: write the draft to a tmp file, open
 * $VISUAL || $EDITOR || vi on it (blocking), read the result back. The app is
 * responsible for raw-mode juggling around the call.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EDITOR_FILE_BYTES, readTextFdBounded } from "./bounded-file.js";

export type EditorResult = { ok: true; text: string } | { ok: false; error: string };
export type EditorLaunchResult = { ok: true } | { ok: false; error: string };

/** Split an editor env value without invoking a shell. */
export function parseEditorCommand(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  const push = () => {
    if (started) args.push(current);
    current = "";
    started = false;
  };

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"') {
        i += 1;
        if (i >= value.length) throw new Error("editor command ends with an escape");
        current += value[i]!;
      } else {
        current += char;
      }
      started = true;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      i += 1;
      if (i >= value.length) throw new Error("editor command ends with an escape");
      current += value[i]!;
      started = true;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) throw new Error("editor command has an unterminated quote");
  push();
  return args;
}

/** Open an existing file with $VISUAL || $EDITOR || vi. */
export function openFileInExternalEditor(file: string): EditorLaunchResult {
  try {
    const [cmd, ...args] = parseEditorCommand(process.env.VISUAL || process.env.EDITOR || "vi");
    if (!cmd) return { ok: false, error: "no editor configured" };
    const result = spawnSync(cmd, [...args, file], { stdio: "inherit" });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) return { ok: false, error: `${cmd} exited with status ${result.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Open `text` in the user's editor and return the edited content. */
export function openInExternalEditor(text: string, tempRoot = tmpdir()): EditorResult {
  let dir: string | undefined;
  try {
    dir = realpathSync(mkdtempSync(join(tempRoot, "seekforge-edit-")));
    const file = join(dir, "draft.md");
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const launched = openFileInExternalEditor(file);
    if (!launched.ok) return launched;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== file) {
      return { ok: false, error: "editor result is not a private regular file" };
    }
    const readFd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      return { ok: true, text: readTextFdBounded(readFd, file, MAX_EDITOR_FILE_BYTES) };
    } finally {
      closeSync(readFd);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
