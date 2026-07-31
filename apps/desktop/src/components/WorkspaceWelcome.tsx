import { useCallback, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { useT } from "../lib/i18n";
import { canPickDirectory, pickDirectory } from "../lib/pickDirectory";
import { useStore } from "../store";
import { Button, Input } from "./ui";
import { IconFiles, LogoMark } from "./ui/icons";

/** Project chooser shown after the shell boots without a real workspace. */
export function WorkspaceWelcome() {
  const t = useT();
  const recents = useStore((state) => state.recents);
  const openWorkspace = useStore((state) => state.openWorkspace);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(
    async (candidate: string) => {
      setBusy(true);
      setError(null);
      try {
        await openWorkspace(candidate);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : String(cause instanceof Error ? cause.message : cause));
      } finally {
        setBusy(false);
      }
    },
    [openWorkspace],
  );

  const chooseFolder = useCallback(async () => {
    if (!canPickDirectory()) {
      setManual(true);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    try {
      const selected = await pickDirectory();
      if (selected) await open(selected);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [open]);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-8 text-center">
          <LogoMark size={36} className="mx-auto text-accent" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-primary">{t("workspace.welcomeTitle")}</h1>
          <p className="mt-2 text-sm leading-relaxed text-secondary">{t("workspace.welcomeDescription")}</p>
        </div>

        <div className="rounded-2xl border border-subtle bg-surface-raised p-4 shadow-sm">
          <Button className="w-full justify-center" onClick={() => void chooseFolder()} disabled={busy}>
            <IconFiles size={16} />
            {t("workspace.open")}
          </Button>

          {manual && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (path.trim()) void open(path.trim());
              }}
            >
              <Input
                ref={inputRef}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t("workspace.pathPlaceholder")}
                aria-label={t("workspace.pathPlaceholder")}
                className="min-w-0 flex-1 font-mono"
              />
              <Button type="submit" disabled={busy || !path.trim()}>
                {t("workspace.openAction")}
              </Button>
            </form>
          )}

          {recents.length > 0 && (
            <div className="mt-4 border-t border-subtle pt-3">
              <div className="mb-1 px-1 text-2xs font-medium uppercase tracking-wider text-tertiary">
                {t("workspace.recent")}
              </div>
              <div className="space-y-1">
                {recents.map((recent) => (
                  <button
                    key={recent.path}
                    type="button"
                    disabled={busy}
                    onClick={() => void open(recent.path)}
                    className="focus-ring block w-full rounded-lg px-3 py-2 text-left hover:bg-surface-overlay disabled:opacity-50"
                    title={recent.path}
                  >
                    <span className="block text-sm font-medium text-primary">{recent.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-2xs text-tertiary">{recent.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
