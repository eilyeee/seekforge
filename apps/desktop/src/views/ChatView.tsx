import { useEffect, useMemo, useRef, useState } from "react";
import { activeTab, useStore, type StartMode } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import { Composer, type ComposerCommand } from "../components/chat/Composer";
import { PermissionModal } from "../components/chat/PermissionModal";
import { QuestionModal } from "../components/chat/QuestionModal";
import { TabBar } from "../components/chat/TabBar";
import { UsageFooter } from "../components/chat/UsageFooter";
import { ConfirmDialog } from "../components/ConfirmDialog";

const MODES: { mode: StartMode; label: string; hint: string }[] = [
  { mode: "edit", label: "Edit", hint: "make changes" },
  { mode: "plan", label: "Plan", hint: "produce a plan first (read-only)" },
  { mode: "ask", label: "Ask", hint: "read-only Q&A" },
];

/** Worktree dialog state: discard confirm, post-merge delete confirm, conflict report. */
type WorktreeDialog =
  | { kind: "discard"; tabId: string }
  | { kind: "merged"; tabId: string }
  | { kind: "conflict"; files: string[] };

export function ChatView() {
  const tabsState = useStore((s) => s.tabs);
  const workspaces = useStore((s) => s.workspaces);
  const tab = activeTab(tabsState);
  const { sendTask, cancel, newSession, respondPermission, respondQuestion, connect } = useStore.getState();
  const { openTab, closeTab, setActiveTab, setMode, setAutoApprove, executePlan, setView } = useStore.getState();
  const { openWorktreeTab, mergeWorktree, discardWorktree } = useStore.getState();
  const workspaceName = (ws: string) => workspaces.find((w) => w.id === ws)?.name;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[tab.tabId] ?? "";
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [tab.tabId]: text }));

  /** Tab id pending close confirmation (running tab — closing cancels the run). */
  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  const [worktreeDialog, setWorktreeDialog] = useState<WorktreeDialog | null>(null);
  /** Transient bottom-right toast. */
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  };

  const newWorktreeSession = () => {
    openWorktreeTab().catch((e: unknown) => showToast(`Worktree failed: ${e instanceof Error ? e.message : e}`));
  };

  const requestMergeBack = (tabId: string) => {
    mergeWorktree(tabId)
      .then((result) => {
        if ("conflict" in result) {
          // Merge was aborted server-side; worktree and base are untouched.
          setWorktreeDialog({ kind: "conflict", files: result.files });
        } else {
          showToast("Worktree merged back");
          setWorktreeDialog({ kind: "merged", tabId });
        }
      })
      .catch((e: unknown) => showToast(`Merge failed: ${e instanceof Error ? e.message : e}`));
  };

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

  const submit = (task: string) => {
    if (!task || tab.chat.running) return;
    sendTask(task);
    setDraft("");
  };

  // Slash-command registry for the composer palette. Pure UI/store actions —
  // anything needing server support stays out (e.g. /compact has no endpoint).
  const tabMode = tab.mode;
  const composerCommands = useMemo<ComposerCommand[]>(
    () => [
      { name: "new", hint: "start a fresh session in this tab", run: newSession },
      {
        name: "plan",
        hint: "toggle Plan mode for the next start (read-only plan first)",
        run: () => setMode(tabMode === "plan" ? "edit" : "plan"),
      },
      { name: "edit", hint: "Edit mode for the next start (make changes)", run: () => setMode("edit") },
      { name: "ask", hint: "Ask mode for the next start (read-only Q&A)", run: () => setMode("ask") },
      { name: "model", hint: "switch the model (opens Settings)", run: () => setView("settings") },
      { name: "sessions", hint: "browse and resume past sessions", run: () => setView("sessions") },
      { name: "diff", hint: "view the working-tree diff", run: () => setView("diff") },
      { name: "skills", hint: "installed skills", run: () => setView("skills") },
      { name: "agents", hint: "dispatchable subagents", run: () => setView("agents") },
      { name: "memory", hint: "project memory and candidates", run: () => setView("memory") },
      { name: "evolution", hint: "self-evolution proposals", run: () => setView("evolution") },
      { name: "settings", hint: "server configuration", run: () => setView("settings") },
    ],
    [newSession, setMode, setView, tabMode],
  );

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
        onNewWorktree={newWorktreeSession}
        onMergeWorktree={requestMergeBack}
        onDiscardWorktree={(tabId) => setWorktreeDialog({ kind: "discard", tabId })}
        workspaceName={workspaceName}
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

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={submit}
        disabled={tab.chat.running}
        placeholder={tab.chat.running ? "agent is running…" : "What should the agent do? (/ commands · @ files)"}
        commands={composerCommands}
        workspaceId={tab.ws ?? ""}
      />

      <UsageFooter usage={tab.chat.usage} context={tab.chat.contextUsage} conn={tab.conn} />

      {tab.pendingPermission && (
        <PermissionModal request={tab.pendingPermission.request} onRespond={respondPermission} />
      )}

      {!tab.pendingPermission && tab.pendingQuestion && (
        <QuestionModal
          question={tab.pendingQuestion.question}
          options={tab.pendingQuestion.options}
          onAnswer={respondQuestion}
        />
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

      {worktreeDialog?.kind === "discard" && (
        <ConfirmDialog
          title="Discard worktree?"
          confirmLabel="Discard"
          danger
          onConfirm={() => {
            const { tabId } = worktreeDialog;
            setWorktreeDialog(null);
            discardWorktree(tabId)
              .then(() => showToast("Worktree discarded"))
              .catch((e: unknown) => showToast(`Discard failed: ${e instanceof Error ? e.message : e}`));
          }}
          onCancel={() => setWorktreeDialog(null)}
        >
          The worktree checkout and its branch are deleted permanently — any unmerged work in this session
          is lost. The tab closes too.
        </ConfirmDialog>
      )}

      {worktreeDialog?.kind === "merged" && (
        <ConfirmDialog
          title="Merged back"
          confirmLabel="Delete worktree & close tab"
          onConfirm={() => {
            const { tabId } = worktreeDialog;
            setWorktreeDialog(null);
            discardWorktree(tabId).catch((e: unknown) =>
              showToast(`Cleanup failed: ${e instanceof Error ? e.message : e}`),
            );
          }}
          onCancel={() => setWorktreeDialog(null)}
        >
          The worktree branch was merged into the base workspace. Delete the worktree and close this tab?
          (Cancel keeps both — you can continue working and merge again later.)
        </ConfirmDialog>
      )}

      {worktreeDialog?.kind === "conflict" && (
        <ConfirmDialog
          title="Merge conflict — nothing was changed"
          confirmLabel="OK"
          onConfirm={() => setWorktreeDialog(null)}
          onCancel={() => setWorktreeDialog(null)}
        >
          <p className="mb-2">
            The merge was aborted; the base workspace and the worktree are untouched. Conflicting files:
          </p>
          <ul className="max-h-48 list-inside list-disc overflow-y-auto font-mono text-xs text-amber-300">
            {worktreeDialog.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-400">
            Resolve the divergence (e.g. update the worktree from the base branch) and merge again.
          </p>
        </ConfirmDialog>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
