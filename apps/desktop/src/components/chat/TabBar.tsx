import type { ChatTab } from "../../lib/tabs";
import { formatUsd } from "../../lib/usage";

type Props = {
  tabs: ChatTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  /** Parent confirms before closing a running tab. */
  onClose: (tabId: string) => void;
  onNew: () => void;
};

/** Session tab strip: running dot per tab, close ×, + for a new tab. */
export function TabBar({ tabs, activeTabId, onSelect, onClose, onNew }: Props) {
  const totalCost = tabs.reduce((sum, t) => sum + t.chat.usage.costUsd, 0);
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/40 px-2 pt-1.5"
      title={`${tabs.length} tab(s) · total ${formatUsd(totalCost)}`}
    >
      {tabs.map((tab) => {
        const active = tab.tabId === activeTabId;
        return (
          <div
            key={tab.tabId}
            onClick={() => onSelect(tab.tabId)}
            className={`group flex max-w-48 cursor-pointer items-center gap-1.5 rounded-t border-x border-t px-2.5 py-1 text-xs ${
              active
                ? "border-zinc-700 bg-zinc-950 text-zinc-100"
                : "border-transparent text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
            }`}
          >
            {tab.pendingPermission ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" title="waiting for approval" />
            ) : tab.chat.running ? (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" title="running" />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700" />
            )}
            <span className="truncate" title={tab.title}>
              {tab.title}
            </span>
            <button
              type="button"
              aria-label={`close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.tabId);
              }}
              className="ml-0.5 rounded px-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="new tab"
        onClick={onNew}
        className="ml-0.5 mb-1 rounded px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        +
      </button>
    </div>
  );
}
