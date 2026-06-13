import type { ComponentType } from "react";
import { activeTab, useStore, type View } from "../store";
import {
  IconAgents,
  IconChat,
  IconDiff,
  IconEvolution,
  IconMemory,
  IconSessions,
  IconSettings,
  IconSkills,
  LogoMark,
} from "./ui/icons";

const NAV: { view: View; label: string; Icon: ComponentType<{ size?: number; className?: string }> }[] = [
  { view: "chat", label: "Chat", Icon: IconChat },
  { view: "sessions", label: "Sessions", Icon: IconSessions },
  { view: "diff", label: "Diff", Icon: IconDiff },
  { view: "skills", label: "Skills", Icon: IconSkills },
  { view: "agents", label: "Agents", Icon: IconAgents },
  { view: "memory", label: "Memory", Icon: IconMemory },
  { view: "evolution", label: "Evolve", Icon: IconEvolution },
  { view: "settings", label: "Settings", Icon: IconSettings },
];

/** Extra top padding on macOS: the window uses an overlay title bar, so the
 *  traffic lights float over the sidebar's top-left corner. */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

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
    <aside className="flex w-48 shrink-0 flex-col border-r border-subtle bg-surface-raised/60">
      <div
        data-tauri-drag-region
        className={`flex items-center gap-2 px-4 pb-3 ${IS_MAC ? "pt-9" : "pt-4"}`}
      >
        <LogoMark size={18} className="text-accent" />
        <span className="text-sm font-semibold tracking-tight text-primary">
          Seek<span className="text-accent">Forge</span>
        </span>
      </div>
      {workspaces.length > 0 && (
        <div className="px-3 pb-3">
          <label className="mb-1 block px-1 text-[10px] uppercase tracking-wider text-tertiary">
            Workspace
          </label>
          <select
            value={activeWorkspaceId}
            onChange={(e) => setActiveWorkspace(e.target.value)}
            title={workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? ""}
            className="focus-ring w-full truncate rounded-lg border border-strong bg-surface px-2 py-1 text-xs text-primary focus:border-accent/70"
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
        {NAV.map(({ view: v, label, Icon }) => {
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-current={active ? "page" : undefined}
              className={`focus-ring group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                active
                  ? "bg-accent-muted/70 font-medium text-primary"
                  : "text-secondary hover:bg-surface-overlay hover:text-primary"
              }`}
            >
              <Icon
                size={15}
                className={active ? "text-accent" : "text-tertiary group-hover:text-secondary"}
              />
              {label}
            </button>
          );
        })}
      </nav>
      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={toggleTodos}
          title="cross-session todo list (.seekforge/todos.md)"
          className={`flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm ${
            todosOpen ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay/50 hover:text-primary"
          }`}
        >
          <span className="w-5 font-mono text-xs text-tertiary">☑</span>
          Todos
        </button>
      </div>
      <div className="flex items-center gap-1.5 border-t border-subtle px-4 py-3 font-mono text-[10px] text-tertiary">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            conn === "connected" ? "bg-ok" : conn === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
          }`}
        />
        {conn}
      </div>
    </aside>
  );
}
