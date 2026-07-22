import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type View } from "../store";
import { useT } from "../lib/i18n";
import { filterPaletteItems, type PaletteItem } from "../lib/palette";
import { pickDirectory } from "../lib/pickDirectory";
import { IconSearch } from "./ui/icons";

/** Views surfaced in the palette, in sidebar order. */
const VIEW_ITEMS: { view: View; navKey: string }[] = [
  { view: "chat", navKey: "nav.chat" },
  { view: "sessions", navKey: "nav.sessions" },
  { view: "diff", navKey: "nav.diff" },
  { view: "files", navKey: "nav.files" },
  { view: "git", navKey: "nav.git" },
  { view: "skills", navKey: "nav.skills" },
  { view: "agents", navKey: "nav.agents" },
  { view: "memory", navKey: "nav.memory" },
  { view: "evolution", navKey: "nav.evolution" },
  { view: "hooks", navKey: "nav.hooks" },
  { view: "diagnostics", navKey: "nav.diagnostics" },
  { view: "settings", navKey: "nav.settings" },
];

/**
 * Global ⌘K / Ctrl+K command palette. Mounted at the app root; opens via the
 * keyboard shortcut (handled here) or the store's `paletteOpen` flag. Lists the
 * views and quick actions, fuzzy-filtered, with arrow/enter/esc navigation.
 */
export function CommandPalette() {
  const t = useT();
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const setView = useStore((s) => s.setView);
  const openTab = useStore((s) => s.openTab);
  const openWorkspace = useStore((s) => s.openWorkspace);

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcuts: ⌘K toggles the palette; ⌘P opens the "go to file" finder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(!useStore.getState().paletteOpen);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        // Don't stack the file finder over an already-open modal/dialog (the
        // shared Modal component sets role="dialog").
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        useStore.getState().openFilesFinder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Reset query/selection and focus the input each time it opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = () => setOpen(false);

  const items = useMemo<PaletteItem[]>(() => {
    const views: PaletteItem[] = VIEW_ITEMS.map(({ view, navKey }) => ({
      id: `view:${view}`,
      label: t("palette.go", { label: t(navKey) }),
      section: "views",
      view,
    }));
    const actions: PaletteItem[] = [
      { id: "action:new-session", label: t("palette.newSession"), section: "actions", run: () => openTab() },
      {
        id: "action:open-folder",
        label: t("palette.openFolder"),
        section: "actions",
        run: () => {
          void pickDirectory().then((path) => {
            if (path) void openWorkspace(path).catch(() => {});
          });
        },
      },
    ];
    return [...views, ...actions];
  }, [t, openTab, openWorkspace]);

  const filtered = useMemo(() => filterPaletteItems(query, items), [query, items]);
  const selIndex = filtered.length === 0 ? 0 : Math.min(sel, filtered.length - 1);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    if (item.view) setView(item.view);
    else item.run?.();
  };

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) setSel((selIndex + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) setSel((selIndex - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[selIndex]);
    }
  };

  // Section headers are rendered inline; track when the section changes.
  let lastSection: PaletteItem["section"] | null = null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label={t("palette.close")}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-subtle bg-surface-raised shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
          <IconSearch size={15} className="shrink-0 text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            className="w-full bg-transparent text-sm text-primary placeholder:text-tertiary focus:outline-none"
          />
        </div>

        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-tertiary">{t("palette.empty")}</li>
          ) : (
            filtered.map((item, i) => {
              const showHeader = item.section !== lastSection;
              lastSection = item.section;
              const active = i === selIndex;
              return (
                <li key={item.id}>
                  {showHeader && (
                    <div className="px-3 pb-1 pt-2 text-2xs uppercase tracking-wider text-tertiary">
                      {item.section === "views" ? t("palette.sectionViews") : t("palette.sectionActions")}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setSel(i)}
                    onClick={() => choose(item)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-sm ${
                      active ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay"
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
