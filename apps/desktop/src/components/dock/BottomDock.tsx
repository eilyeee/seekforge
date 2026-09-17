import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatItem } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { detectLoopbackUrls } from "../../lib/preview-urls";
import { activeTab, useStore } from "../../store";
import { PreviewPanel } from "./PreviewPanel";
import { TerminalPanel } from "./TerminalPanel";

const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 280;

/** Loopback URLs in the recent command output of a chat transcript. */
export function urlsFromChat(items: readonly ChatItem[]): string[] {
  const text: string[] = [];
  for (const item of items.slice(-40)) {
    if (item.kind !== "tool") continue;
    if (item.tail) text.push(item.tail);
    if (item.result?.data !== undefined) text.push(JSON.stringify(item.result.data).replace(/\\n/g, "\n"));
  }
  return detectLoopbackUrls(text.join("\n"));
}

/**
 * The bottom dock under every view: a workspace terminal and a local preview.
 * It stays mounted while closed so a running shell (a dev server, say) keeps
 * going; Ctrl+` toggles the terminal.
 */
export function BottomDock() {
  const t = useT();
  const dock = useStore((s) => s.dock);
  const setDock = useStore((s) => s.setDock);
  const previewUrl = useStore((s) => s.previewUrl);
  const setPreviewUrl = useStore((s) => s.setPreviewUrl);
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const chatItems = useStore((s) => activeTab(s.tabs).chat.items);
  const [terminalUrls, setTerminalUrls] = useState<string[]>([]);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        const current = useStore.getState().dock;
        setDock({ open: !(current.open && current.panel === "terminal"), panel: "terminal" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDock]);

  const suggestions = useMemo(() => {
    const merged = [...urlsFromChat(chatItems), ...terminalUrls];
    return merged.filter((url, index) => merged.lastIndexOf(url) === index);
  }, [chatItems, terminalUrls]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.75));
    setHeight(Math.min(max, Math.max(MIN_HEIGHT, drag.current.startHeight + drag.current.startY - e.clientY)));
  };

  return (
    <section
      aria-label={t("dock.label")}
      className={`shrink-0 flex-col border-t border-subtle bg-surface ${dock.open ? "flex" : "hidden"}`}
      style={{ height }}
    >
      <button
        type="button"
        aria-label={t("dock.resize")}
        title={t("dock.resize")}
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startHeight: height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.75));
          setHeight((current) => Math.min(max, Math.max(MIN_HEIGHT, current + (e.key === "ArrowUp" ? 24 : -24))));
        }}
        className="focus-ring h-1.5 w-full shrink-0 cursor-row-resize bg-transparent hover:bg-accent/40 focus-visible:bg-accent/40"
      />
      <div className="flex shrink-0 items-center gap-1 border-b border-subtle px-2">
        {(["terminal", "preview"] as const).map((panel) => (
          <button
            key={panel}
            type="button"
            role="tab"
            aria-selected={dock.panel === panel}
            onClick={() => setDock({ panel })}
            className={`focus-ring rounded-t px-2.5 py-1 text-xs ${
              dock.panel === panel ? "border-b-2 border-accent text-primary" : "text-tertiary hover:text-secondary"
            }`}
          >
            {t(`dock.${panel}`)}
            {panel === "preview" && suggestions.length > 0 && !previewUrl && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
            )}
          </button>
        ))}
        <button
          type="button"
          aria-label={t("dock.close")}
          title={t("dock.close")}
          onClick={() => setDock({ open: false })}
          className="focus-ring ml-auto rounded px-2 py-0.5 text-tertiary hover:bg-surface-overlay hover:text-primary"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <div className={dock.panel === "terminal" ? "h-full" : "hidden"}>
          <TerminalPanel
            workspaceId={workspaceId}
            visible={dock.open && dock.panel === "terminal"}
            onUrls={setTerminalUrls}
          />
        </div>
        <div className={dock.panel === "preview" ? "h-full" : "hidden"}>
          <PreviewPanel url={previewUrl} onUrl={setPreviewUrl} suggestions={suggestions} />
        </div>
      </div>
    </section>
  );
}
