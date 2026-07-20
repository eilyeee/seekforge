/**
 * Cross-session todo list stored as a markdown checklist at
 * <workspace>/.seekforge/todos.md — the SINGLE implementation of the FORMAT
 * CONTRACT previously duplicated in apps/tui/src/todos.ts and
 * apps/server/src/todos.ts (which drifted; see the todos newline-collapse fix
 * that had to be applied twice).
 *
 * FORMAT CONTRACT: only `- [ ] text` / `- [x] text` lines are todos; every
 * other line (headings, prose) is preserved verbatim across read/write
 * round-trips. Indices are 1-based and count checklist lines only.
 *
 * NODE-ONLY: this module touches the filesystem, so it lives behind the
 * "./todos" subpath export and is deliberately NOT re-exported from index.ts —
 * the package root must stay browser-safe for the desktop bundle.
 *
 * Error policy: write failures THROW. Server routes turn them into structured
 * errors and the TUI surfaces them, so neither UI reports an unpersisted change
 * as successful.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Todo = { index: number; text: string; done: boolean };

const CHECKLIST_RE = /^- \[( |x|X)\] (.*)$/;

function todosFile(workspace: string, createParent = false): string {
  const root = realpathSync(resolve(workspace));
  const stateDir = join(root, ".seekforge");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createParent) throw error;
    try {
      mkdirSync(stateDir, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    stat = lstatSync(stateDir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(stateDir) !== stateDir) {
    throw new Error("todo state directory must be a workspace-owned physical directory");
  }
  return join(stateDir, "todos.md");
}

function readLines(workspace: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(todosFile(workspace), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return [];
    const lines = readFileSync(fd, "utf8").split("\n");
    // A trailing newline yields one empty last element; drop it so writes
    // (which re-append "\n") do not accumulate blank lines.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Throws on an unwritable workspace (see the error policy note above). */
function writeLines(workspace: string, lines: readonly string[]): void {
  const file = todosFile(workspace, true);
  const dir = dirname(file);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== file) {
      throw new Error("todo state file must be a workspace-owned regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = join(dir, `.todos.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const data = Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error("todo write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (todosFile(workspace, false) !== file) throw new Error("todo state path changed during write");
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(file) !== file) {
        throw new Error("todo state file changed during write");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temp, file);

    let dirFd: number | undefined;
    try {
      dirFd = openSync(dir, constants.O_RDONLY);
      fsyncSync(dirFd);
    } catch {
      // Some filesystems do not support directory fsync.
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function parseTodo(line: string, index: number): Todo | null {
  const match = CHECKLIST_RE.exec(line);
  if (!match) return null;
  return { index, text: match[2] as string, done: (match[1] as string).toLowerCase() === "x" };
}

/** Loads todos from .seekforge/todos.md; [] when the file is missing. */
export function loadTodos(workspace: string): Todo[] {
  const todos: Todo[] = [];
  for (const line of readLines(workspace)) {
    const todo = parseTodo(line, todos.length + 1);
    if (todo) todos.push(todo);
  }
  return todos;
}

/**
 * Collapses interior newlines in a todo text: a raw "\n" would split one todo
 * into a checklist line plus a stray prose line, silently truncating it on
 * read-back. Exported so the TUI wrapper can mirror addTodo's return value
 * when it swallows a write failure.
 */
export function collapseTodoText(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Appends a new unchecked todo (creating .seekforge/ if needed) and returns it. */
export function addTodo(workspace: string, text: string): Todo {
  const single = collapseTodoText(text);
  const lines = readLines(workspace);
  lines.push(`- [ ] ${single}`);
  writeLines(workspace, lines);
  const index = lines.filter((l) => CHECKLIST_RE.test(l)).length;
  return { index, text: single, done: false };
}

/** Maps a 1-based todo index to its line offset in the file; -1 if out of range. */
function lineIndexOf(lines: readonly string[], index: number): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (CHECKLIST_RE.test(lines[i] as string)) {
      seen += 1;
      if (seen === index) return i;
    }
  }
  return -1;
}

/** Flips the [ ]/[x] state of the todo at `index`; null when out of range. */
export function toggleTodo(workspace: string, index: number): Todo | null {
  const lines = readLines(workspace);
  const at = lineIndexOf(lines, index);
  if (at === -1) return null;
  const todo = parseTodo(lines[at] as string, index) as Todo;
  const flipped = !todo.done;
  lines[at] = `- [${flipped ? "x" : " "}] ${todo.text}`;
  writeLines(workspace, lines);
  return { index, text: todo.text, done: flipped };
}

/** Removes the todo at `index` (its line only); null when out of range. */
export function removeTodo(workspace: string, index: number): Todo | null {
  const lines = readLines(workspace);
  const at = lineIndexOf(lines, index);
  if (at === -1) return null;
  const todo = parseTodo(lines[at] as string, index) as Todo;
  lines.splice(at, 1);
  writeLines(workspace, lines);
  return todo;
}
