import { useState, type ComponentType } from "react";
import { activeTab, useStore, type View } from "../store";
import { useT } from "../lib/i18n";
import {
  IconAgents,
  IconChat,
  IconChevron,
  IconDiff,
  IconEvolution,
  IconFiles,
  IconGit,
  IconMemory,
  IconSessions,
  IconSettings,
  IconSkills,
  LogoMark,
} from "./ui/icons";

const COLLAPSE_KEY = "seekforge.sidebarCollapsed";
function readCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function storeCollapsed(v: boolean): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    /* private-mode / quota — non-fatal */
  }
}

type NavItem = { view: View; key: string; Icon: ComponentType<{ size?: number; className?: string }> };

/**
 * Grouped navigation (Codex-style calm sidebar). The first group has no header
 * (the primary conversation surface); the rest carry a quiet section label.
 */
const NAV_GROUPS: { titleKey?: string; items: NavItem[] }[] = [
  {
    items: [
      { view: "chat", key: "nav.chat", Icon: IconChat },
      { view: "sessions", key: "nav.sessions", Icon: IconSessions },
    ],
  },
  {
    titleKey: "nav.group.code",
    items: [
      { view: "files", key: "nav.files", Icon: IconFiles },
      { view: "diff", key: "nav.diff", Icon: IconDiff },
      { view: "git", key: "nav.git", Icon: IconGit },
    ],
  },
  {
    titleKey: "nav.group.agent",
    items: [
      { view: "skills", key: "nav.skills", Icon: IconSkills },
      { view: "agents", key: "nav.agents", Icon: IconAgents },
      { view: "memory", key: "nav.memory", Icon: IconMemory },
      { view: "evolution", key: "nav.evolution", Icon: IconEvolution },
    ],
  },
  {
    titleKey: "nav.group.system",
    items: [
      { view: "settings", key: "nav.settings", Icon: IconSettings },
      { view: "diagnostics", key: "nav.diagnostics", Icon: IconSettings },
    ],
  },
];

/** Extra top padding on macOS: the window uses an overlay title bar, so the
 *  traffic lights float over the sidebar's top-left corner. */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function Sidebar() {
  const t = useT();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const todosOpen = useStore((s) => s.todosOpen);
  const toggleTodos = useStore((s) => s.toggleTodos);
  // Connection state of the active tab's socket (each tab owns one).
  const conn = useStore((s) => activeTab(s.tabs).conn);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      storeCollapsed(!c);
      return !c;
    });
  };

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-subtle bg-surface-raised/60 transition-[width] duration-150 ${
        collapsed ? "w-14" : "w-[220px]"
      }`}
    >
      <div
        data-tauri-drag-region
        className={`flex gap-2 pb-3 ${IS_MAC ? "pt-9" : "pt-4"} ${
          collapsed ? "flex-col items-center px-0" : "items-center px-4"
        }`}
      >
        <LogoMark size={18} className="text-accent" />
        {!collapsed && (
          <span className="text-sm font-semibold tracking-tight text-primary">
            Seek<span className="text-accent">Forge</span>
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={t(collapsed ? "nav.expand" : "nav.collapse")}
          aria-label={t(collapsed ? "nav.expand" : "nav.collapse")}
          className={`focus-ring rounded p-1 text-tertiary hover:bg-surface-overlay hover:text-secondary ${
            collapsed ? "" : "ml-auto"
          }`}
        >
          <IconChevron size={14} className={collapsed ? "rotate-90" : "-rotate-90"} />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.titleKey ?? `g${gi}`} className={gi === 0 ? "space-y-0.5" : "mt-4 space-y-0.5"}>
            {group.titleKey && !collapsed && (
              <div className="px-2.5 pb-1 text-2xs font-medium uppercase tracking-wider text-tertiary">
                {t(group.titleKey)}
              </div>
            )}
            {/* A thin divider stands in for the group label when collapsed. */}
            {group.titleKey && collapsed && <div className="mx-2 my-1.5 border-t border-subtle" />}
            {group.items.map(({ view: v, key, Icon }) => {
              const active = view === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? t(key) : undefined}
                  className={`focus-ring group flex w-full items-center gap-2.5 rounded-lg py-2 text-left text-sm transition-colors ${
                    collapsed ? "justify-center px-0" : "px-2.5"
                  } ${
                    active
                      ? "bg-accent-muted font-medium text-accent"
                      : "text-secondary hover:bg-surface-overlay hover:text-primary"
                  }`}
                >
                  <Icon
                    size={16}
                    className={active ? "text-accent" : "text-tertiary group-hover:text-secondary"}
                  />
                  {!collapsed && t(key)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={toggleTodos}
          title={t("todos.title")}
          aria-pressed={todosOpen}
          className={`focus-ring flex w-full items-center gap-2.5 rounded py-1.5 text-left text-sm ${
            collapsed ? "justify-center px-0" : "px-2.5"
          } ${
            todosOpen ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay/50 hover:text-primary"
          }`}
        >
          <span aria-hidden className="font-mono text-xs text-tertiary">☑</span>
          {!collapsed && t("nav.todos")}
        </button>
      </div>
      {/* Connection status (collapse toggle lives in the header now). */}
      <div
        className={`flex items-center border-t border-subtle py-2.5 font-mono text-2xs text-tertiary ${
          collapsed ? "justify-center px-0" : "gap-1.5 px-4"
        }`}
      >
        <span
          title={t(`status.${conn}`)}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            conn === "connected" ? "bg-ok" : conn === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
          }`}
        />
        {!collapsed && <span className="flex-1">{t(`status.${conn}`)}</span>}
      </div>
    </aside>
  );
}
