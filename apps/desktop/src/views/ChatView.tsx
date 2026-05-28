import { useEffect, useMemo, useRef, useState } from "react";
import { activeTab, useStore, type ApprovalChoice, type StartMode } from "../store";
import { api } from "../lib/api";
import { mapToServerTurn, userTurnOf } from "../lib/backtrack";
import { buildHandoff, handoffFilename } from "../lib/handoff";
import { ChatItems } from "../components/chat/ChatItems";
import { Composer, type ComposerCommand } from "../components/chat/Composer";
import { PermissionModal } from "../components/chat/PermissionModal";
import { QuestionModal } from "../components/chat/QuestionModal";
import { TabBar } from "../components/chat/TabBar";
import { UsageFooter } from "../components/chat/UsageFooter";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button, EmptyState } from "../components/ui";
import type { AccountBalance, ServerConfig } from "../types";

const MODES: { mode: StartMode; label: string; hint: string }[] = [
  { mode: "edit", label: "Edit", hint: "make changes" },
  { mode: "plan", label: "Plan", hint: "produce a plan first (read-only)" },
  { mode: "ask", label: "Ask", hint: "read-only Q&A" },
];

const APPROVALS: { value: ApprovalChoice; label: string; hint: string }[] = [
  { value: "confirm", label: "Confirm", hint: "approvalMode: confirm — prompt before each tool" },
  { value: "acceptEdits", label: "Accept edits", hint: "approvalMode: acceptEdits — auto-approve file edits, prompt for the rest" },
  { value: "auto", label: "Auto", hint: "approvalMode: auto — run every tool without prompting ⚠" },
];

/** Worktree dialog state: discard confirm, post-merge delete confirm, conflict report. */
type WorktreeDialog =
  | { kind: "discard"; tabId: string }
  | { kind: "merged"; tabId: string }
  | { kind: "conflict"; files: string[] };

/** Known DeepSeek V4 models (the input also accepts any free-text model id). */
const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];

export function ChatView() {
  const tabsState = useStore((s) => s.tabs);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const tab = activeTab(tabsState);
  const { sendTask, cancel, newSession, respondPermission, respondQuestion, connect } = useStore.getState();
  const { openTab, closeTab, setActiveTab, setMode, setApprovalMode, executePlan, setView } = useStore.getState();
  const { openWorktreeTab, mergeWorktree, discardWorktree } = useStore.getState();
  const { setModel, setThinking, setReasoningEffort, truncateAtItem } = useStore.getState();
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

  /** Server config (sandbox badge + thinking default); refreshed per workspace. */
  const [config, setConfig] = useState<ServerConfig | null>(null);
  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [activeWorkspaceId]);

  /** Account balance chip: fetched on mount and again after each run ends. */
  const [balance, setBalance] = useState<AccountBalance | null>(null);
  const running = tab.chat.running;
  useEffect(() => {
    if (running) return;
    let alive = true;
    api
      .balance()
      .then((r) => {
        // null = unknown; keep showing the previous value (fetchBalance contract).
        if (alive && r.balance) setBalance(r.balance);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [running, activeWorkspaceId]);

  /** Backtrack dialog state (user item pending the rewind confirmation). */
  const [backtrackItem, setBacktrackItem] = useState<number | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [backtrackError, setBacktrackError] = useState<string | null>(null);

  const confirmBacktrack = async () => {
    const itemId = backtrackItem;
    const sessionId = tab.chat.sessionId;
    setBacktrackItem(null);
    if (itemId === null || !sessionId) return;
    const local = userTurnOf(tab.chat.items, itemId);
    if (!local) return;
    try {
      // Server turns index ALL user messages of messages.jsonl; align the
      // local bubble ordinal to them from the end (see lib/backtrack.ts).
      const turns = await api.sessionTurns(sessionId, tab.ws);
      const turn = mapToServerTurn(local.turn, local.count, turns.length);
      if (turn <= 0 || turn >= turns.length || !turns[turn]?.backtrackable) {
        throw new Error(`turn ${turn} is not backtrackable`);
      }
      await api.backtrack(sessionId, turn, restoreFiles, tab.ws);
      truncateAtItem(itemId);
      setBacktrackError(null);
    } catch (e) {
      setBacktrackError(String(e));
    }
  };

  const downloadHandoff = () => {
    const markdown = buildHandoff({
      items: tab.chat.items,
      sessionId: tab.chat.sessionId ?? undefined,
      model: tab.model.trim() || config?.model || "(config default)",
      costUsd: tab.chat.usage.costUsd,
    });
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = handoffFilename();
    a.click();
    URL.revokeObjectURL(url);
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

      <header className="flex flex-wrap items-center gap-3 border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">Chat</h1>
        {tab.chat.sessionId && (
          <span className="rounded bg-surface-overlay px-2 py-0.5 font-mono text-2xs text-secondary">
            {tab.chat.sessionId}
          </span>
        )}
        {tab.chat.running && (
          <span className="flex items-center gap-1.5 text-xs text-warn">
            <span className="h-2 w-2 animate-pulse rounded-full bg-warn" />
            running
          </span>
        )}

        <div className="flex items-center rounded border border-strong" title="mode for the next start">
          {MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              type="button"
              disabled={!modeSelectable}
              title={hint}
              onClick={() => setMode(mode)}
              className={`px-2.5 py-1 text-xs first:rounded-l last:rounded-r disabled:opacity-50 ${
                tab.mode === mode ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center rounded border border-strong" title="approval mode for the next start">
          {APPROVALS.map(({ value, label, hint }) => {
            const active = tab.approvalMode === value;
            const activeClass =
              value === "auto"
                ? "bg-warn/15 text-warn"
                : value === "acceptEdits"
                  ? "bg-accent-muted text-accent-hover"
                  : "bg-surface-overlay text-primary";
            return (
              <button
                key={value}
                type="button"
                disabled={!modeSelectable}
                title={hint}
                onClick={() => setApprovalMode(value)}
                className={`px-2.5 py-1 text-xs first:rounded-l last:rounded-r disabled:opacity-50 ${
                  active ? activeClass : "text-secondary hover:bg-surface-overlay"
                }`}
              >
                {label}
                {value === "auto" && active ? " ⚠" : ""}
              </button>
            );
          })}
        </div>

        <input
          list="model-suggestions"
          value={tab.model}
          onChange={(e) => setModel(e.target.value)}
          disabled={tab.chat.running}
          placeholder={config?.model ?? "model (config default)"}
          title="model for the next message; empty = server config default"
          className="w-44 rounded border border-strong bg-surface px-2 py-1 font-mono text-xs text-primary placeholder:text-tertiary focus:border-accent/70 focus:outline-none disabled:opacity-50"
        />
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs ${
            (tab.thinking ?? config?.thinking ?? false)
              ? "border-accent/60 bg-accent-muted text-accent-hover"
              : "border-strong text-secondary"
          }`}
          title="DeepSeek V4 thinking mode for the next message (✻ reasoning stream)"
        >
          <input
            type="checkbox"
            checked={tab.thinking ?? config?.thinking ?? false}
            onChange={(e) => setThinking(e.target.checked)}
            disabled={tab.chat.running}
            className="accent-accent"
          />
          think
        </label>
        {(tab.thinking ?? config?.thinking ?? false) && (
          <select
            value={tab.reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as "high" | "max")}
            disabled={tab.chat.running}
            title="reasoning effort (thinking mode)"
            className="rounded border border-strong bg-surface px-1.5 py-1 text-xs text-secondary focus:border-accent/70 focus:outline-none disabled:opacity-50"
          >
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        )}

        {config && (
          <span
            title="OS command sandbox (config: sandbox)"
            className={`rounded px-1.5 py-0.5 font-mono text-2xs ${
              config.sandbox && config.sandbox !== "off"
                ? "bg-ok/10 text-ok/80"
                : "bg-surface-overlay text-tertiary"
            }`}
          >
            sandbox: {config.sandbox ?? "off"}
          </span>
        )}

        <div className="ml-auto flex gap-2">
          {tab.planReady && !tab.chat.running && tab.chat.sessionId && (
            <Button size="sm" variant="primary" onClick={executePlan}>
              Execute plan
            </Button>
          )}
          {tab.chat.running && (
            <Button size="sm" variant="danger" onClick={cancel}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={downloadHandoff}
            disabled={tab.chat.items.length === 0}
            title="Download a markdown handoff brief of this conversation"
          >
            Handoff
          </Button>
          <Button size="sm" onClick={newSession}>
            New session
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => scrollPos.current.set(tab.tabId, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {tab.chat.items.length === 0 ? (
          <EmptyState
            icon={<div className="font-mono text-2xl text-tertiary">&gt;_</div>}
            title="Ask SeekForge to do something"
            description={
              <>
                Describe a coding task to start a session.
                <br />
                Enter sends · Shift+Enter inserts a newline
              </>
            }
          />
        ) : (
          <ChatItems
            items={tab.chat.items}
            onBacktrack={
              tab.chat.sessionId && !tab.chat.running
                ? (itemId) => {
                    setRestoreFiles(false);
                    setBacktrackError(null);
                    setBacktrackItem(itemId);
                  }
                : undefined
            }
          />
        )}
      </div>

      {backtrackError && (
        <div className="border-t border-danger/40 bg-danger/10 px-4 py-1.5 font-mono text-xs text-danger">
          backtrack failed: {backtrackError}
        </div>
      )}

      {tab.chat.retry && (
        <div className="border-t border-warn/40 bg-warn/10 px-4 py-1.5 font-mono text-xs text-warn">
          ⟳ retrying ({tab.chat.retry.attempt}/{tab.chat.retry.maxAttempts}) in{" "}
          {(tab.chat.retry.delayMs / 1000).toFixed(1)}s — {tab.chat.retry.reason}
        </div>
      )}

      {tab.wsError && (
        <div className="border-t border-warn/40 bg-warn/10 px-4 py-1.5 font-mono text-xs text-warn">
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

      <UsageFooter usage={tab.chat.usage} context={tab.chat.contextUsage} conn={tab.conn} balance={balance} />

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

      {backtrackItem !== null && (
        <ConfirmDialog
          title="Rewind conversation to here?"
          confirmLabel="Rewind"
          danger
          onConfirm={() => void confirmBacktrack()}
          onCancel={() => setBacktrackItem(null)}
        >
          <p>
            This message and everything after it are removed from the session transcript. The next
            message continues from the earlier state.
          </p>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={restoreFiles}
              onChange={(e) => setRestoreFiles(e.target.checked)}
              className="accent-danger"
            />
            also restore files changed by the removed turns (checkpoint restore)
          </label>
        </ConfirmDialog>
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
          <ul className="max-h-48 list-inside list-disc overflow-y-auto font-mono text-xs text-warn">
            {worktreeDialog.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-secondary">
            Resolve the divergence (e.g. update the worktree from the base branch) and merge again.
          </p>
        </ConfirmDialog>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded border border-strong bg-surface-raised px-4 py-2 text-sm text-primary shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
