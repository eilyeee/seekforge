import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import type { Todo } from "../types";
import { Badge, Button, Input, IconSparkle, IconArrowRight, IconCornerDownRight } from "./ui";

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

  const active = todos?.filter((todo) => !todo.done) ?? [];
  const done = todos?.filter((todo) => todo.done) ?? [];

  const row = (todo: Todo) => (
    <li
      key={todo.index}
      className="group flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-overlay"
    >
      <input
        type="checkbox"
        checked={todo.done}
        disabled={busy}
        onChange={() => run({ op: "toggle", index: todo.index })}
        className="focus-ring mt-0.5 h-4 w-4 shrink-0 rounded accent-accent disabled:cursor-not-allowed"
      />
      <span
        className={`flex-1 text-sm leading-snug ${
          todo.done ? "text-tertiary line-through" : "text-primary"
        }`}
      >
        {todo.text}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => run({ op: "remove", index: todo.index })}
        title={t("todos.removeTitle")}
        className="focus-ring mt-0.5 shrink-0 rounded text-tertiary opacity-0 transition hover:text-danger group-hover:opacity-100 disabled:cursor-not-allowed"
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </li>
  );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-subtle bg-surface">
      <div className="border-b border-subtle px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold text-primary">
            {t("nav.todos")}
            {todos !== null && (
              <span className="text-tertiary">· {active.length}</span>
            )}
          </span>
        </div>
        <span className="mt-1 block font-mono text-2xs text-tertiary">.seekforge/todos.md</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {error && (
          <div className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
        {todos === null ? (
          <p className="px-2 text-xs text-tertiary">{t("todos.loading")}</p>
        ) : todos.length === 0 ? (
          <p className="px-2 text-xs text-tertiary">{t("todos.empty")}</p>
        ) : (
          <div className="space-y-4">
            {active.length > 0 && (
              <section>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-tertiary">
                  <IconSparkle size={13} />
                  <span className="flex-1 text-2xs font-medium uppercase tracking-wider">{t("todos.active")}</span>
                  <Badge tone="accent">{active.length}</Badge>
                </div>
                <ul className="space-y-0.5">{active.map(row)}</ul>
              </section>
            )}

            {done.length > 0 && (
              <section className={active.length > 0 ? "border-t border-subtle pt-3" : undefined}>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-tertiary">
                  <IconCornerDownRight size={13} />
                  <span className="flex-1 text-2xs font-medium uppercase tracking-wider">{t("todos.done")}</span>
                  <Badge tone="ok">{done.length}</Badge>
                </div>
                <ul className="space-y-0.5">{done.map(row)}</ul>
              </section>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-subtle p-3">
        <div className="relative">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) add();
            }}
            placeholder={t("todos.addPlaceholder")}
            className="pr-10"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={add}
            disabled={busy || !draft.trim()}
            aria-label={t("todos.addPlaceholder")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1.5 py-1"
          >
            <IconArrowRight size={14} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
