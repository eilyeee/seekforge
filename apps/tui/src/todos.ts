/**
 * TUI adapter over the shared todos implementation (@seekforge/shared/todos —
 * the single owner of the .seekforge/todos.md FORMAT CONTRACT; the parsing/
 * writing logic that used to be duplicated here now lives there).
 *
 * The shared functions throw on write failure. The slash-command caller turns
 * that into a visible error, so the TUI never reports a mutation that was not
 * persisted. Every mutation also holds the same workspace guard as Agent and
 * Server write surfaces.
 */

import {
  addTodo as sharedAddTodo,
  loadTodos,
  removeTodo as sharedRemoveTodo,
  toggleTodo as sharedToggleTodo,
  type Todo,
} from "@seekforge/shared/todos";
import { acquireWorkspaceSessionGuard } from "@seekforge/core";

export type { Todo };
export { loadTodos };

function mutateTodo<T>(workspace: string, operation: () => T): T {
  const guard = acquireWorkspaceSessionGuard(workspace);
  try {
    return operation();
  } finally {
    guard.release();
  }
}

/** Appends a new unchecked todo (creating .seekforge/ if needed) and returns it. */
export function addTodo(workspace: string, text: string): Todo {
  return mutateTodo(workspace, () => sharedAddTodo(workspace, text));
}

/** Flips the [ ]/[x] state of the todo at `index`; null when out of range. */
export function toggleTodo(workspace: string, index: number): Todo | null {
  return mutateTodo(workspace, () => sharedToggleTodo(workspace, index));
}

/** Removes the todo at `index` (its line only); null when out of range. */
export function removeTodo(workspace: string, index: number): Todo | null {
  return mutateTodo(workspace, () => sharedRemoveTodo(workspace, index));
}

/** Display lines for /todos: "1. ☐ text" / "2. ☑ text" (caller dims done items). */
export function formatTodoLines(todos: readonly Todo[]): string[] {
  if (todos.length === 0) return ["no todos — /todo add <text>"];
  return todos.map((t) => `${t.index}. ${t.done ? "☑" : "☐"} ${t.text}`);
}
