import { useEffect, useRef, useState, type ComponentType } from "react";
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
  IconShield,
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
      { view: "hooks", key: "nav.hooks", Icon: IconShield },
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobilePanelRef = useRef<HTMLElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMobile = () => {
    setMobileOpen(false);
    window.requestAnimationFrame(() => mobileTriggerRef.current?.focus());
  };

  useEffect(() => {
    if (!mobileOpen) return;
    mobilePanelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobile();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(mobilePanelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      storeCollapsed(!c);
      return !c;
    });
  };

  const rail = (desktop: boolean) => (
    <aside
      data-tauri-drag-region
      className={`${desktop ? "hidden sm:flex" : "flex sm:hidden"} w-10 shrink-0 flex-col items-center border-r border-subtle bg-surface-raised/60 ${
        IS_MAC ? "pt-9" : "pt-3"
      }`}
    >
      <button
        ref={desktop ? undefined : mobileTriggerRef}
        type="button"
        onClick={desktop ? toggleCollapsed : () => setMobileOpen(true)}
        title={t("nav.expand")}
        aria-label={t("nav.expand")}
        className="focus-ring rounded p-1.5 text-tertiary hover:bg-surface-overlay hover:text-secondary"
      >
        <IconChevron size={16} />
      </button>
    </aside>
  );

  const full = (mobile: boolean) => (
    <aside
      ref={mobile ? mobilePanelRef : undefined}
      role={mobile ? "dialog" : undefined}
      aria-modal={mobile ? true : undefined}
      aria-label={mobile ? t("nav.group.system") : undefined}
      className={`${mobile ? "fixed inset-y-0 left-0 z-50 flex shadow-xl sm:hidden" : "hidden sm:flex"} w-[220px] shrink-0 flex-col border-r border-subtle bg-surface-raised`}
    >
      <div
        data-tauri-drag-region
        className={`flex items-center gap-2 px-4 pb-3 ${IS_MAC ? "pt-9" : "pt-4"}`}
      >
        <LogoMark size={18} className="text-accent" />
        <span className="text-sm font-semibold tracking-tight text-primary">
          Seek<span className="text-accent">Forge</span>
        </span>
        <button
          type="button"
          onClick={mobile ? closeMobile : toggleCollapsed}
          title={t(mobile ? "nav.close" : "nav.collapse")}
          aria-label={t(mobile ? "nav.close" : "nav.collapse")}
          className="focus-ring ml-auto rounded p-1 text-tertiary hover:bg-surface-overlay hover:text-secondary"
        >
          <IconChevron size={14} className="rotate-180" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.titleKey ?? `g${gi}`} className={gi === 0 ? "space-y-0.5" : "mt-4 space-y-0.5"}>
            {group.titleKey && (
              <div className="px-2.5 pb-1 text-2xs font-medium uppercase tracking-wider text-tertiary">
                {t(group.titleKey)}
              </div>
            )}
            {group.items.map(({ view: v, key, Icon }) => {
              const active = view === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setView(v);
                    if (mobile) closeMobile();
                  }}
                  aria-current={active ? "page" : undefined}
                  className={`focus-ring group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                    active
                      ? "bg-accent-muted font-medium text-accent"
                      : "text-secondary hover:bg-surface-overlay hover:text-primary"
                  }`}
                >
                  <Icon
                    size={16}
                    className={active ? "text-accent" : "text-tertiary group-hover:text-secondary"}
                  />
                  {t(key)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="px-2 pb-1">
        <button
          type="button"
          onClick={() => {
            toggleTodos();
            if (mobile) closeMobile();
          }}
          title={t("todos.title")}
          aria-pressed={todosOpen}
          className={`focus-ring flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm ${
            todosOpen ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay/50 hover:text-primary"
          }`}
        >
          <span aria-hidden className="font-mono text-xs text-tertiary">☑</span>
          {t("nav.todos")}
        </button>
      </div>
      <div className="flex items-center gap-1.5 border-t border-subtle px-4 py-2.5 font-mono text-2xs text-tertiary">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            conn === "connected" ? "bg-ok" : conn === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
          }`}
        />
        {t(`status.${conn}`)}
      </div>
    </aside>
  );

  return (
    <>
      {rail(false)}
      {collapsed ? rail(true) : full(false)}
      {mobileOpen && (
        <>
          <button
            type="button"
            aria-label={t("nav.close")}
            className="fixed inset-0 z-40 bg-black/30 sm:hidden"
            onClick={closeMobile}
          />
          {full(true)}
        </>
      )}
    </>
  );
}
