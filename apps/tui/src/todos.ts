import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cross-session todo list stored as a markdown checklist at
 * <workspace>/.seekforge/todos.md. Only `- [ ] text` / `- [x] text` lines are
 * todos; any other lines (headings, prose) are preserved verbatim across
 * load/save round-trips. Indices are 1-based and count checklist lines only.
 */
export type Todo = { index: number; text: string; done: boolean };

const CHECKLIST_RE = /^- \[( |x|X)\] (.*)$/;

function todosFile(workspace: string): string {
  return path.join(workspace, ".seekforge", "todos.md");
}

function readLines(workspace: string): string[] {
  try {
    const raw = fs.readFileSync(todosFile(workspace), "utf8");
    const lines = raw.split("\n");
    // A trailing newline yields one empty last element; drop it so writes
    // (which re-append "\n") do not accumulate blank lines.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  }
}

function writeLines(workspace: string, lines: readonly string[]): void {
  const file = todosFile(workspace);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  } catch {
    // unwritable workspace — drop the change silently rather than throw
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

/** Appends a new unchecked todo (creating .seekforge/ if needed) and returns it. */
export function addTodo(workspace: string, text: string): Todo {
  const lines = readLines(workspace);
  lines.push(`- [ ] ${text}`);
  writeLines(workspace, lines);
  const index = lines.filter((l) => CHECKLIST_RE.test(l)).length;
  return { index, text, done: false };
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

/** Display lines for /todos: "1. ☐ text" / "2. ☑ text" (caller dims done items). */
export function formatTodoLines(todos: readonly Todo[]): string[] {
  if (todos.length === 0) return ["no todos — /todo add <text>"];
  return todos.map((t) => `${t.index}. ${t.done ? "☑" : "☐"} ${t.text}`);
}
