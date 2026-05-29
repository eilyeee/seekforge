import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import type { Todo } from "../types";

/**
 * Right-side drawer over the cross-session todo list (.seekforge/todos.md,
 * GET/POST /api/todos). Every mutation returns the updated list, so the
 * panel simply replaces its state with each response.
 */
export function TodosPanel() {
  const t = useT();
  const ws = useStore((s) => s.activeWorkspaceId);
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTodos(null);
    setError(null);
    api
      .todos()
      .then(setTodos)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const run = (op: Parameters<typeof api.todosOp>[0]) => {
    setBusy(true);
    api
      .todosOp(op)
      .then((list) => {
        setTodos(list);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const add = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    run({ op: "add", text });
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-100">{t("nav.todos")}</span>
        <span className="font-mono text-2xs text-zinc-600">.seekforge/todos.md</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-2 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>
        )}
        {todos === null ? (
          <p className="text-xs text-zinc-600">{t("todos.loading")}</p>
        ) : todos.length === 0 ? (
          <p className="text-xs text-zinc-600">{t("todos.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {todos.map((todo) => (
              <li key={todo.index} className="group flex items-start gap-2 rounded px-1.5 py-1 hover:bg-zinc-800/50">
                <input
                  type="checkbox"
                  checked={todo.done}
                  disabled={busy}
                  onChange={() => run({ op: "toggle", index: todo.index })}
                  className="mt-0.5 accent-emerald-600"
                />
                <span className={`flex-1 text-sm ${todo.done ? "text-zinc-600 line-through" : "text-zinc-200"}`}>
                  {todo.text}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ op: "remove", index: todo.index })}
                  title={t("todos.removeTitle")}
                  className="text-xs text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
          }}
          placeholder={t("todos.addPlaceholder")}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
        />
      </div>
    </aside>
  );
}
