import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { worktreeLabel, type ChatTab } from "../../lib/tabs";
import { formatUsd } from "../../lib/usage";
import { IconChevron } from "../ui";

type Props = {
  tabs: ChatTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  /** Parent confirms before closing a running tab. */
  onClose: (tabId: string) => void;
  onNew: () => void;
  /** "+" menu: New worktree session (isolated branch; merge back when done). */
  onNewWorktree: () => void;
  /** Worktree tab menu actions. */
  onMergeWorktree: (tabId: string) => void;
  onDiscardWorktree: (tabId: string) => void;
  /** Workspace id -> display name, for the per-tab workspace label. */
  workspaceName?: (ws: string) => string | undefined;
};

/** Closes the dropdown on any outside click. */
function useCloseOnOutsideClick(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = () => close();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);
}

/** Session tab strip: running dot per tab, close ×, + menu for new tabs. */
export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onNewWorktree,
  onMergeWorktree,
  onDiscardWorktree,
  workspaceName,
}: Props) {
  const t = useT();
  // Only label tabs by workspace when more than one workspace is in play
  // (worktree tabs always carry their branch chip instead).
  const distinctWs = new Set(tabs.map((t) => t.ws).filter(Boolean));
  const showWs = distinctWs.size > 1;
  const totalCost = tabs.reduce((sum, t) => sum + t.chat.usage.costUsd, 0);

  /** Which dropdown is open: the "+" menu or a worktree tab's menu. */
  const [menu, setMenu] = useState<"new" | string | null>(null);
  useCloseOnOutsideClick(menu !== null, () => setMenu(null));

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-subtle bg-surface/40 px-2 pt-1.5"
      title={t("chat.tab.tabsSummary", { count: tabs.length, cost: formatUsd(totalCost) })}
    >
      {tabs.map((tab) => {
        const active = tab.tabId === activeTabId;
        return (
          <div
            key={tab.tabId}
            onClick={() => onSelect(tab.tabId)}
            className={`group relative flex max-w-56 cursor-pointer items-center gap-1.5 rounded-t border-x border-t px-2.5 py-1 text-xs ${
              active
                ? "border-strong bg-surface text-primary"
                : "border-transparent text-tertiary hover:bg-surface-overlay/60 hover:text-secondary"
            }`}
          >
            {tab.pendingPermission ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" title={t("chat.tab.waitingApproval")} />
            ) : tab.chat.running ? (
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warn" title={t("chat.tab.running")} />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-surface-overlay" />
            )}
            <span className="truncate" title={tab.title}>
              {tab.title}
            </span>
            {tab.worktree && (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-surface-overlay px-1 text-2xs text-secondary"
                title={tab.worktree.dirty ? t("chat.tab.worktreeBranchDirty", { branch: tab.worktree.branch }) : t("chat.tab.worktreeBranch", { branch: tab.worktree.branch })}
              >
                ⎇ {worktreeLabel(tab.worktree)}
                {tab.worktree.dirty && (
                  <span className="h-1.5 w-1.5 rounded-full bg-warn" title={t("chat.tab.uncommitted")} />
                )}
              </span>
            )}
            {showWs && tab.ws && !tab.worktree && (
              <span
                className="shrink-0 rounded bg-surface-overlay px-1 text-2xs uppercase tracking-wide text-secondary"
                title={t("chat.tab.workspace", { name: workspaceName?.(tab.ws) ?? tab.ws })}
              >
                {workspaceName?.(tab.ws) ?? tab.ws}
              </span>
            )}
            {tab.worktree && (
              <button
                type="button"
                aria-label={t("chat.tab.worktreeMenuLabel", { title: tab.title })}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === tab.tabId ? null : tab.tabId);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="rounded px-0.5 text-tertiary hover:bg-surface-overlay hover:text-primary"
              >
                <IconChevron size={12} className="rotate-90" />
              </button>
            )}
            <button
              type="button"
              aria-label={t("chat.tab.closeLabel", { title: tab.title })}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.tabId);
              }}
              className="ml-0.5 rounded px-0.5 text-tertiary hover:bg-surface-overlay hover:text-primary"
            >
              ×
            </button>
            {menu === tab.tabId && tab.worktree && (
              <div
                className="absolute left-0 top-full z-40 mt-0.5 w-44 rounded border border-strong bg-surface-raised py-1 shadow-lg"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    onMergeWorktree(tab.tabId);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-primary hover:bg-surface-overlay"
                >
                  {t("chat.tab.mergeBack")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    onDiscardWorktree(tab.tabId);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-surface-overlay"
                >
                  {t("chat.tab.discard")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="relative">
        <button
          type="button"
          aria-label={t("chat.tab.newTabMenuLabel")}
          onClick={() => setMenu(menu === "new" ? null : "new")}
          onMouseDown={(e) => e.stopPropagation()}
          className="ml-0.5 mb-1 rounded px-2 py-0.5 text-sm text-tertiary hover:bg-surface-overlay hover:text-primary"
        >
          +
        </button>
        {menu === "new" && (
          <div
            className="absolute left-0 top-full z-40 w-52 rounded border border-strong bg-surface-raised py-1 shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onNew();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-primary hover:bg-surface-overlay"
            >
              {t("chat.tab.newTab")}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onNewWorktree();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-primary hover:bg-surface-overlay"
              title={t("chat.tab.newWorktreeTitle")}
            >
              {t("chat.tab.newWorktreeSession")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
