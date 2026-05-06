import { activeTab, useStore, type View } from "../store";

const NAV: { view: View; label: string; glyph: string }[] = [
  { view: "chat", label: "Chat", glyph: ">_" },
  { view: "sessions", label: "Sessions", glyph: "≡" },
  { view: "diff", label: "Diff", glyph: "±" },
  { view: "skills", label: "Skills", glyph: "✦" },
  { view: "agents", label: "Agents", glyph: "⤷" },
  { view: "memory", label: "Memory", glyph: "◈" },
  { view: "evolution", label: "Evolve", glyph: "↻" },
  { view: "settings", label: "Settings", glyph: "⚙" },
];

export function Sidebar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const todosOpen = useStore((s) => s.todosOpen);
  const toggleTodos = useStore((s) => s.toggleTodos);
  // Connection state of the active tab's socket (each tab owns one).
  const conn = useStore((s) => activeTab(s.tabs).conn);

  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="px-4 py-3 font-mono text-sm font-bold tracking-tight text-emerald-400">
        seek<span className="text-zinc-100">forge</span>
      </div>
      {workspaces.length > 0 && (
        <div className="px-3 pb-2">
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-600">Workspace</label>
          <select
            value={activeWorkspaceId}
            onChange={(e) => setActiveWorkspace(e.target.value)}
            title={workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? ""}
            className="w-full truncate rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-emerald-700 focus:outline-none"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id} title={w.path}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <nav className="flex-1 space-y-0.5 px-2">
        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            onClick={() => setView(item.view)}
            className={`flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm ${
              view === item.view
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            }`}
          >
            <span className="w-5 font-mono text-xs text-zinc-500">{item.glyph}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={toggleTodos}
          title="cross-session todo list (.seekforge/todos.md)"
          className={`flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm ${
            todosOpen ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
          }`}
        >
          <span className="w-5 font-mono text-xs text-zinc-500">☑</span>
          Todos
        </button>
      </div>
      <div className="flex items-center gap-1.5 px-4 py-3 font-mono text-[10px] text-zinc-600">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            conn === "connected" ? "bg-emerald-500" : conn === "connecting" ? "bg-amber-500" : "bg-red-500"
          }`}
        />
        {conn}
      </div>
    </aside>
  );
}
