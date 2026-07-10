/**
 * TUI adapter over the shared todos implementation (@seekforge/shared/todos —
 * the single owner of the .seekforge/todos.md FORMAT CONTRACT; the parsing/
 * writing logic that used to be duplicated here now lives there).
 *
 * The shared functions THROW on write failure (the server turns that into a
 * 500). The TUI's historical behavior is to drop the change silently on an
 * unwritable workspace rather than crash the slash-command handler, while
 * still reporting the todo the write WOULD have produced — the catch blocks
 * below reproduce exactly that, computing the same return values the old
 * in-app implementation returned when its writeLines swallowed the error.
 */

import {
  addTodo as sharedAddTodo,
  collapseTodoText,
  loadTodos,
  removeTodo as sharedRemoveTodo,
  toggleTodo as sharedToggleTodo,
  type Todo,
} from "@seekforge/shared/todos";

export type { Todo };
export { loadTodos };

/** Appends a new unchecked todo (creating .seekforge/ if needed) and returns it. */
export function addTodo(workspace: string, text: string): Todo {
  try {
    return sharedAddTodo(workspace, text);
  } catch {
    // unwritable workspace — drop the change silently rather than throw.
    // The old code still returned the would-be todo: text collapsed, index =
    // (existing checklist lines) + 1. The file is unchanged, so loadTodos
    // reproduces the pre-write count.
    return { index: loadTodos(workspace).length + 1, text: collapseTodoText(text), done: false };
  }
}

/** Flips the [ ]/[x] state of the todo at `index`; null when out of range. */
export function toggleTodo(workspace: string, index: number): Todo | null {
  try {
    return sharedToggleTodo(workspace, index);
  } catch {
    // unwritable workspace — report the flip without persisting it (legacy UX).
    const todo = loadTodos(workspace).find((t) => t.index === index);
    return todo ? { index, text: todo.text, done: !todo.done } : null;
  }
}

/** Removes the todo at `index` (its line only); null when out of range. */
export function removeTodo(workspace: string, index: number): Todo | null {
  try {
    return sharedRemoveTodo(workspace, index);
  } catch {
    // unwritable workspace — report the removal without persisting it (legacy UX).
    return loadTodos(workspace).find((t) => t.index === index) ?? null;
  }
}

/** Display lines for /todos: "1. ☐ text" / "2. ☑ text" (caller dims done items). */
export function formatTodoLines(todos: readonly Todo[]): string[] {
  if (todos.length === 0) return ["no todos — /todo add <text>"];
  return todos.map((t) => `${t.index}. ${t.done ? "☑" : "☐"} ${t.text}`);
}
