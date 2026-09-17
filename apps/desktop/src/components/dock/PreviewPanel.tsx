import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { normalizeLoopbackUrl } from "../../lib/preview-urls";
import { Button, Input } from "../ui";

/**
 * True when the URL would frame the workbench itself (same host and port as
 * this page), which would hand the framed page this window's origin.
 */
export function isWorkbenchUrl(url: string, here: { hostname: string; port: string } | undefined): boolean {
  if (!here) return false;
  const target = new URL(url);
  const local = (host: string) =>
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" ? "loopback" : host;
  return local(target.hostname) === local(here.hostname) && target.port === here.port;
}

type Props = {
  url: string;
  onUrl: (url: string) => void;
  /** Loopback URLs recently printed by commands, newest last. */
  suggestions: string[];
};

/**
 * Frames a local dev server (loopback URLs with an explicit port only) with
 * reload and open-in-browser. The frame is sandboxed without top navigation,
 * so a previewed page cannot take over the workbench.
 */
export function PreviewPanel({ url, onUrl, suggestions }: Props) {
  const t = useT();
  const [draft, setDraft] = useState(url);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(url), [url]);

  const here = typeof window === "undefined" ? undefined : window.location;
  const go = (input: string) => {
    const normalized = normalizeLoopbackUrl(input);
    if (!normalized) {
      setError(t("dock.previewInvalid"));
      return;
    }
    if (isWorkbenchUrl(normalized, here)) {
      setError(t("dock.previewSelf"));
      return;
    }
    setError(null);
    onUrl(normalized);
    setReloadKey((key) => key + 1);
  };

  const offered = suggestions.filter((candidate) => candidate !== url).slice(-4);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-3 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="http://localhost:5173"
          aria-label={t("dock.previewUrlLabel")}
          className="min-w-48 flex-1 py-1 font-mono text-xs"
        />
        <Button size="sm" type="submit">
          {t("dock.previewGo")}
        </Button>
        <Button size="sm" disabled={!url} onClick={() => setReloadKey((key) => key + 1)}>
          {t("dock.previewReload")}
        </Button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring rounded-lg border border-strong px-2.5 py-1 text-xs text-secondary hover:bg-surface-overlay hover:text-primary"
          >
            {t("dock.previewOpenExternal")}
          </a>
        ) : null}
        {offered.length > 0 && (
          <span className="flex w-full flex-wrap items-center gap-1.5 text-2xs text-tertiary">
            {t("dock.previewDetected")}
            {offered.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => go(candidate)}
                className="focus-ring rounded border border-subtle px-1.5 py-0.5 font-mono text-accent hover:bg-surface-overlay"
              >
                {candidate}
              </button>
            ))}
          </span>
        )}
        {error && <span className="w-full text-2xs text-danger">{error}</span>}
      </form>
      {url ? (
        <iframe
          key={reloadKey}
          src={url}
          title={t("dock.preview")}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 bg-white"
        />
      ) : (
        <p className="p-4 text-xs text-tertiary">{t("dock.previewEmpty")}</p>
      )}
    </div>
  );
}
