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
 * Error policy: write failures THROW (the server's behavior — its routes turn
 * them into 500s). The TUI wants its historical "drop the change silently on
 * an unwritable workspace" UX instead; its wrapper (apps/tui/src/todos.ts)
 * catches at the call boundary.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Todo = { index: number; text: string; done: boolean };

const CHECKLIST_RE = /^- \[( |x|X)\] (.*)$/;

function todosFile(workspace: string): string {
  return join(workspace, ".seekforge", "todos.md");
}

function readLines(workspace: string): string[] {
  try {
    const lines = readFileSync(todosFile(workspace), "utf8").split("\n");
    // A trailing newline yields one empty last element; drop it so writes
    // (which re-append "\n") do not accumulate blank lines.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  }
}

/** Throws on an unwritable workspace (see the error policy note above). */
function writeLines(workspace: string, lines: readonly string[]): void {
  const file = todosFile(workspace);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
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
