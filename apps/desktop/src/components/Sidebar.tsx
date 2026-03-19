import { useStore, type View } from "../store";

const NAV: { view: View; label: string; glyph: string }[] = [
  { view: "chat", label: "Chat", glyph: ">_" },
  { view: "sessions", label: "Sessions", glyph: "≡" },
  { view: "diff", label: "Diff", glyph: "±" },
  { view: "skills", label: "Skills", glyph: "✦" },
  { view: "memory", label: "Memory", glyph: "◈" },
  { view: "settings", label: "Settings", glyph: "⚙" },
];

export function Sidebar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const conn = useStore((s) => s.conn);

  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="px-4 py-3 font-mono text-sm font-bold tracking-tight text-emerald-400">
        seek<span className="text-zinc-100">forge</span>
      </div>
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
