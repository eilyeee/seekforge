import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useT } from "../lib/i18n";
import { canPickDirectory, pickDirectory } from "../lib/pickDirectory";
import { ApiError } from "../lib/api";
import { IconChevron, IconFiles } from "./ui/icons";

function useCloseOnOutsideClick(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = () => close();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);
}

/**
 * Sidebar workspace control: switch between hosted workspaces, open a new folder
 * (native picker in the Tauri shell, manual path input in a browser), reopen a
 * recent project, and remove/forget entries.
 */
export function WorkspaceMenu({ compact = false }: { compact?: boolean } = {}) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const recents = useStore((s) => s.recents);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const forgetRecent = useStore((s) => s.forgetRecent);

  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setManual(false);
    setError(null);
  }, []);
  useCloseOnOutsideClick(open, close);

  useEffect(() => {
    if (manual) inputRef.current?.focus();
  }, [manual]);

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const defaultId = workspaces[0]?.id;

  const doOpen = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        await openWorkspace(path);
        close();
        setPathInput("");
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [openWorkspace, close],
  );

  const onOpenFolder = useCallback(async () => {
    if (canPickDirectory()) {
      const picked = await pickDirectory();
      if (picked) await doOpen(picked);
    } else {
      setManual(true);
    }
  }, [doOpen]);

  return (
    <div
      className={compact ? "relative" : "relative px-3 pb-3"}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {!compact && (
        <label className="mb-1 block px-1 text-2xs uppercase tracking-wider text-tertiary">
          {t("nav.workspace")}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={active?.path ?? ""}
        aria-expanded={open}
        className={
          compact
            ? "focus-ring inline-flex h-7 items-center gap-1.5 rounded-lg border border-strong bg-surface px-2 text-xs font-medium text-primary hover:border-accent/60"
            : "focus-ring flex w-full items-center gap-1.5 rounded-lg border border-strong bg-surface px-2 py-1.5 text-left text-xs text-primary hover:border-accent/60"
        }
      >
        {compact && <IconFiles size={13} className="shrink-0 text-tertiary" />}
        <span className={compact ? "max-w-[10rem] truncate" : "flex-1 truncate"}>
          {active?.name ?? t("workspace.openProject")}
        </span>
        <IconChevron size={12} className={`shrink-0 text-tertiary ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className={`absolute z-50 overflow-hidden rounded-lg border border-strong bg-surface-raised shadow-lg ${
            compact ? "bottom-full left-0 mb-1 w-72" : "left-3 right-3 top-full mt-1"
          }`}
        >
          <div className="max-h-72 overflow-auto py-1">
            {/* Hosted workspaces */}
            {workspaces.map((w) => (
              <div
                key={w.id}
                className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs ${
                  w.id === activeWorkspaceId ? "bg-accent-muted text-accent" : "text-secondary hover:bg-surface-overlay"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveWorkspace(w.id);
                    close();
                  }}
                  title={w.path}
                  className="flex-1 truncate text-left"
                >
                  {w.name}
                </button>
                {/* Worktrees (wt-*) own a git checkout — they are removed via
                    the worktree merge/discard flow, not "stop hosting". */}
                {w.id !== defaultId && !w.id.startsWith("wt-") && (
                  <button
                    type="button"
                    onClick={() => void removeWorkspace(w.id)}
                    title={t("workspace.remove")}
                    className="shrink-0 px-1 text-tertiary opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}

            {/* Recent (not currently hosted) */}
            {recents.length > 0 && (
              <div className="mt-1 border-t border-subtle pt-1">
                <div className="px-2 py-1 text-2xs uppercase tracking-wider text-tertiary">
                  {t("workspace.recent")}
                </div>
                {recents.map((r) => (
                  <div
                    key={r.path}
                    className="group flex items-center gap-1.5 px-2 py-1.5 text-xs text-secondary hover:bg-surface-overlay"
                  >
                    <button
                      type="button"
                      onClick={() => void doOpen(r.path)}
                      title={r.path}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate">{r.name}</span>
                      <span className="block truncate text-2xs text-tertiary">{r.path}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void forgetRecent(r.path)}
                      title={t("workspace.forget")}
                      className="shrink-0 px-1 text-tertiary opacity-0 hover:text-danger group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Open folder */}
          <div className="border-t border-subtle p-2">
            {manual ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pathInput.trim()) void doOpen(pathInput.trim());
                }}
                className="space-y-1.5"
              >
                <input
                  ref={inputRef}
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder={t("workspace.pathPlaceholder")}
                  className="focus-ring w-full rounded border border-strong bg-surface px-2 py-1 font-mono text-2xs text-primary focus:border-accent/70"
                />
                <button
                  type="submit"
                  disabled={busy || !pathInput.trim()}
                  className="focus-ring w-full rounded bg-accent px-2 py-1 text-2xs font-medium text-white disabled:opacity-50"
                >
                  {t("workspace.openAction")}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => void onOpenFolder()}
                disabled={busy}
                className="focus-ring flex w-full items-center justify-center gap-1.5 rounded bg-accent-muted px-2 py-1.5 text-xs font-medium text-accent hover:bg-accent-muted/70 disabled:opacity-50"
              >
                <span aria-hidden>＋</span>
                {t("workspace.open")}
              </button>
            )}
            {error && <p className="mt-1.5 px-0.5 text-2xs text-danger">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
