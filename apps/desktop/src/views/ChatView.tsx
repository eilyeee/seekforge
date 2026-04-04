import { useEffect, useRef, useState } from "react";
import { activeTab, useStore, type StartMode } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import { PermissionModal } from "../components/chat/PermissionModal";
import { TabBar } from "../components/chat/TabBar";
import { UsageFooter } from "../components/chat/UsageFooter";
import { ConfirmDialog } from "../components/ConfirmDialog";

const MODES: { mode: StartMode; label: string; hint: string }[] = [
  { mode: "edit", label: "Edit", hint: "make changes" },
  { mode: "plan", label: "Plan", hint: "produce a plan first (read-only)" },
  { mode: "ask", label: "Ask", hint: "read-only Q&A" },
];

export function ChatView() {
  const tabsState = useStore((s) => s.tabs);
  const tab = activeTab(tabsState);
  const { sendTask, cancel, newSession, respondPermission, connect } = useStore.getState();
  const { openTab, closeTab, setActiveTab, setMode, setAutoApprove, executePlan } = useStore.getState();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[tab.tabId] ?? "";
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [tab.tabId]: text }));

  /** Tab id pending close confirmation (running tab — closing cancels the run). */
  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPos = useRef(new Map<string, number>());
  const prevTabId = useRef(tab.tabId);

  useEffect(() => {
    connect();
  }, [connect, tab.tabId]);

  // Follow the stream, but restore the saved scroll position on tab switch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevTabId.current !== tab.tabId) {
      prevTabId.current = tab.tabId;
      el.scrollTop = scrollPos.current.get(tab.tabId) ?? el.scrollHeight;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [tab.tabId, tab.chat.items]);

  const submit = () => {
    const task = draft.trim();
    if (!task || tab.chat.running) return;
    sendTask(task);
    setDraft("");
  };

  const requestClose = (tabId: string) => {
    const target = tabsState.tabs.find((t) => t.tabId === tabId);
    if (target?.chat.running) setConfirmClose(tabId);
    else closeTab(tabId);
  };

  const modeSelectable = !tab.chat.sessionId && !tab.chat.running;

  return (
    <div className="flex h-full flex-col">
      <TabBar
        tabs={tabsState.tabs}
        activeTabId={tabsState.activeTabId}
        onSelect={setActiveTab}
        onClose={requestClose}
        onNew={openTab}
      />

      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Chat</h1>
        {tab.chat.sessionId && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
            {tab.chat.sessionId}
          </span>
        )}
        {tab.chat.running && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            running
          </span>
        )}

        <div className="flex items-center rounded border border-zinc-700" title="mode for the next start">
          {MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              type="button"
              disabled={!modeSelectable}
              title={hint}
              onClick={() => setMode(mode)}
              className={`px-2.5 py-1 text-xs first:rounded-l last:rounded-r disabled:opacity-50 ${
                tab.mode === mode ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs ${
            tab.autoApprove
              ? "border-amber-700 bg-amber-950/40 text-amber-300"
              : "border-zinc-700 text-zinc-400"
          }`}
          title="approvalMode: auto — tools run without confirmation prompts"
        >
          <input
            type="checkbox"
            checked={tab.autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="accent-amber-500"
          />
          auto-approve{tab.autoApprove ? " ⚠" : ""}
        </label>

        <div className="ml-auto flex gap-2">
          {tab.planReady && !tab.chat.running && tab.chat.sessionId && (
            <button
              type="button"
              onClick={executePlan}
              className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
            >
              Execute plan
            </button>
          )}
          {tab.chat.running && (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-950"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={newSession}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            New session
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => scrollPos.current.set(tab.tabId, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {tab.chat.items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-zinc-600">
            <div>
              <div className="mb-2 font-mono text-2xl text-zinc-700">&gt;_</div>
              <p>Describe a coding task to start a session.</p>
              <p className="mt-1 text-xs">Enter sends · Shift+Enter inserts a newline</p>
            </div>
          </div>
        ) : (
          <ChatItems items={tab.chat.items} />
        )}
      </div>

      {tab.wsError && (
        <div className="border-t border-amber-900 bg-amber-950/40 px-4 py-1.5 font-mono text-xs text-amber-300">
          {tab.wsError}
        </div>
      )}

      <div className="border-t border-zinc-800 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Don't submit while an IME composition (CJK input) is active.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={tab.chat.running}
          placeholder={tab.chat.running ? "agent is running…" : "What should the agent do?"}
          rows={3}
          className="w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none disabled:opacity-50"
        />
      </div>

      <UsageFooter usage={tab.chat.usage} conn={tab.conn} />

      {tab.pendingPermission && (
        <PermissionModal request={tab.pendingPermission.request} onRespond={respondPermission} />
      )}

      {confirmClose && (
        <ConfirmDialog
          title="Close running tab?"
          confirmLabel="Close tab"
          danger
          onConfirm={() => {
            closeTab(confirmClose);
            setConfirmClose(null);
          }}
          onCancel={() => setConfirmClose(null)}
        >
          This tab has a running session. Closing it disconnects the socket and cancels the run on the server.
        </ConfirmDialog>
      )}
    </div>
  );
}
