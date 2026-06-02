import { useEffect, useMemo, useRef, useState } from "react";
import { activeTab, useStore, type ApprovalChoice, type StartMode } from "../store";
import { api } from "../lib/api";
import { mapToServerTurn, userTurnOf } from "../lib/backtrack";
import { buildHandoff, handoffFilename } from "../lib/handoff";
import { ChatItems } from "../components/chat/ChatItems";
import { HomeWelcome } from "../components/chat/HomeWelcome";
import { Composer, type ComposerCommand } from "../components/chat/Composer";
import { PermissionModal } from "../components/chat/PermissionModal";
import { QuestionModal } from "../components/chat/QuestionModal";
import { TabBar } from "../components/chat/TabBar";
import { UsageFooter } from "../components/chat/UsageFooter";
import { useT } from "../lib/i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/ui";
import type { AccountBalance, ServerConfig } from "../types";

const MODES: { mode: StartMode; key: string; hintKey: string }[] = [
  { mode: "edit", key: "chat.mode.edit", hintKey: "chat.mode.editHint" },
  { mode: "plan", key: "chat.mode.plan", hintKey: "chat.mode.planHint" },
  { mode: "ask", key: "chat.mode.ask", hintKey: "chat.mode.askHint" },
];

const APPROVALS: { value: ApprovalChoice; key: string; hintKey: string }[] = [
  { value: "confirm", key: "chat.approval.confirm", hintKey: "chat.approval.confirmHint" },
  { value: "acceptEdits", key: "chat.approval.acceptEdits", hintKey: "chat.approval.acceptEditsHint" },
  { value: "auto", key: "chat.approval.auto", hintKey: "chat.approval.autoHint" },
];

/** Worktree dialog state: discard confirm, post-merge delete confirm, conflict report. */
type WorktreeDialog =
  | { kind: "discard"; tabId: string }
  | { kind: "merged"; tabId: string }
  | { kind: "conflict"; files: string[] };

/** Known DeepSeek V4 models (the input also accepts any free-text model id). */
const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];

export function ChatView() {
  const t = useT();
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
          showToast(t("chat.mergedToast"));
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
      { name: "new", hint: t("chat.cmdNewHint"), run: newSession },
      {
        name: "plan",
        hint: t("chat.cmdPlanHint"),
        run: () => setMode(tabMode === "plan" ? "edit" : "plan"),
      },
      { name: "edit", hint: t("chat.cmdEditHint"), run: () => setMode("edit") },
      { name: "ask", hint: t("chat.cmdAskHint"), run: () => setMode("ask") },
      { name: "model", hint: t("chat.cmdModelHint"), run: () => setView("settings") },
      { name: "sessions", hint: t("chat.cmdSessionsHint"), run: () => setView("sessions") },
      { name: "diff", hint: t("chat.cmdDiffHint"), run: () => setView("diff") },
      { name: "skills", hint: t("chat.cmdSkillsHint"), run: () => setView("skills") },
      { name: "agents", hint: t("chat.cmdAgentsHint"), run: () => setView("agents") },
      { name: "memory", hint: t("chat.cmdMemoryHint"), run: () => setView("memory") },
      { name: "evolution", hint: t("chat.cmdEvolutionHint"), run: () => setView("evolution") },
      { name: "settings", hint: t("chat.cmdSettingsHint"), run: () => setView("settings") },
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

      <header className="flex flex-wrap items-center gap-2.5 border-b border-subtle px-4 py-2.5">
        <h1 className="text-sm font-semibold text-primary">{t("chat.title")}</h1>
        {tab.chat.sessionId && (
          <span className="rounded bg-surface-overlay px-2 py-0.5 font-mono text-2xs text-secondary">
            {tab.chat.sessionId}
          </span>
        )}
        {tab.chat.running && (
          <span className="flex items-center gap-1.5 text-xs text-warn">
            <span className="h-2 w-2 animate-pulse rounded-full bg-warn" />
            {t("chat.running")}
          </span>
        )}

        <div className="flex items-center rounded-lg border border-subtle p-0.5" title={t("chat.modeTitle")}>
          {MODES.map(({ mode, key, hintKey }) => (
            <button
              key={mode}
              type="button"
              disabled={!modeSelectable}
              title={t(hintKey)}
              onClick={() => setMode(mode)}
              className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                tab.mode === mode ? "bg-accent-muted text-accent" : "text-secondary hover:bg-accent-muted/60"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>

        <div className="flex items-center rounded-lg border border-subtle p-0.5" title={t("chat.approvalTitle")}>
          {APPROVALS.map(({ value, key, hintKey }) => {
            const active = tab.approvalMode === value;
            const activeClass =
              value === "auto"
                ? "bg-warn/15 text-warn"
                : value === "acceptEdits"
                  ? "bg-accent-muted text-accent-hover"
                  : "bg-accent-muted text-accent";
            return (
              <button
                key={value}
                type="button"
                disabled={!modeSelectable}
                title={t(hintKey)}
                onClick={() => setApprovalMode(value)}
                className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                  active ? activeClass : "text-secondary hover:bg-accent-muted/60"
                }`}
              >
                {t(key)}
                {value === "auto" && active ? " ⚠" : ""}
              </button>
            );
          })}
        </div>

        {(() => {
          // Strict picker over the configured model list (config.models, set in
          // Settings). Ensure the active value is always an option, even if it
          // was an id no longer in the list.
          const list = config?.models && config.models.length > 0 ? config.models : MODEL_SUGGESTIONS;
          const selected = tab.model || config?.model || list[0] || "";
          const options = selected && !list.includes(selected) ? [selected, ...list] : list;
          return (
            <select
              value={selected}
              onChange={(e) => setModel(e.target.value)}
              disabled={tab.chat.running}
              title={t("chat.modelTitle")}
              aria-label={t("chat.modelTitle")}
              className="focus-ring w-44 min-w-0 max-w-full flex-shrink rounded-lg border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-primary focus:border-accent/70 disabled:opacity-50"
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          );
        })()}

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
            (tab.thinking ?? config?.thinking ?? false)
              ? "border-accent/60 bg-accent-muted text-accent-hover"
              : "border-strong text-secondary hover:bg-accent-muted/60"
          }`}
          title={t("chat.think")}
        >
          <input
            type="checkbox"
            checked={tab.thinking ?? config?.thinking ?? false}
            onChange={(e) => setThinking(e.target.checked)}
            disabled={tab.chat.running}
            className="accent-accent"
          />
          {t("chat.think")}
        </label>
        {(tab.thinking ?? config?.thinking ?? false) && (
          <select
            value={tab.reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as "high" | "max")}
            disabled={tab.chat.running}
            title={t("chat.reasoningTitle")}
            aria-label={t("chat.reasoningTitle")}
            className="focus-ring rounded-lg border border-strong bg-surface px-2 py-1.5 text-xs text-secondary focus:border-accent/70 disabled:opacity-50"
          >
            <option value="high">{t("chat.reasoning.high")}</option>
            <option value="max">{t("chat.reasoning.max")}</option>
          </select>
        )}

        {config && (
          <span
            title={t("chat.sandboxTitle")}
            className={`rounded px-1.5 py-0.5 font-mono text-2xs ${
              config.sandbox && config.sandbox !== "off"
                ? "bg-ok/10 text-ok/80"
                : "bg-surface-overlay text-tertiary"
            }`}
          >
            {t("chat.sandboxLabel", { mode: config.sandbox ?? "off" })}
          </span>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {tab.planReady && !tab.chat.running && tab.chat.sessionId && (
            <Button size="sm" variant="primary" onClick={executePlan}>
              {t("chat.executePlan")}
            </Button>
          )}
          {tab.chat.running && (
            <Button size="sm" variant="danger" onClick={cancel}>
              {t("action.cancel")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={downloadHandoff}
            disabled={tab.chat.items.length === 0}
            title={t("chat.handoffTitle")}
          >
            {t("chat.handoff")}
          </Button>
          <Button size="sm" onClick={newSession}>
            {t("chat.newSession")}
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => scrollPos.current.set(tab.tabId, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {tab.chat.items.length === 0 ? (
          <HomeWelcome
            onQuickAction={setDraft}
            onNavigate={setView}
            workspaceId={activeWorkspaceId}
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
          {t("chat.backtrackError", { error: backtrackError })}
        </div>
      )}

      {tab.chat.retry && (
        <div className="border-t border-warn/40 bg-warn/10 px-4 py-1.5 font-mono text-xs text-warn">
          <span aria-hidden>⟳</span>{" "}
          {t("chat.retryLabel", {
            attempt: tab.chat.retry.attempt,
            max: tab.chat.retry.maxAttempts,
            delay: (tab.chat.retry.delayMs / 1000).toFixed(1),
            reason: tab.chat.retry.reason,
          })}
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
        placeholder={tab.chat.running ? t("chat.composerRunningPlaceholder") : t("chat.composerPlaceholder", { slash: "/", at: "@" })}
        commands={composerCommands}
        workspaceId={tab.ws ?? ""}
        thinking={tab.thinking ?? config?.thinking ?? false}
        onToggleThinking={() => setThinking(!(tab.thinking ?? config?.thinking ?? false))}
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
          title={t("chat.backtrackTitle")}
          confirmLabel={t("chat.backtrackConfirm")}
          danger
          onConfirm={() => void confirmBacktrack()}
          onCancel={() => setBacktrackItem(null)}
        >
          <p>
            {t("chat.backtrackBody")}
          </p>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={restoreFiles}
              onChange={(e) => setRestoreFiles(e.target.checked)}
              className="accent-danger"
            />
            {t("chat.backtrackRestore")}
          </label>
        </ConfirmDialog>
      )}

      {confirmClose && (
        <ConfirmDialog
          title={t("chat.closeRunningTitle")}
          confirmLabel={t("action.close")}
          danger
          onConfirm={() => {
            closeTab(confirmClose);
            setConfirmClose(null);
          }}
          onCancel={() => setConfirmClose(null)}
        >
          {t("chat.closeRunningBody")}
        </ConfirmDialog>
      )}

      {worktreeDialog?.kind === "discard" && (
        <ConfirmDialog
          title={t("chat.discardTitle")}
          confirmLabel={t("chat.discardConfirm")}
          danger
          onConfirm={() => {
            const { tabId } = worktreeDialog;
            setWorktreeDialog(null);
            discardWorktree(tabId)
              .then(() => showToast(t("chat.discardToast")))
              .catch((e: unknown) => showToast(`Discard failed: ${e instanceof Error ? e.message : e}`));
          }}
          onCancel={() => setWorktreeDialog(null)}
        >
          {t("chat.discardBody")}
        </ConfirmDialog>
      )}

      {worktreeDialog?.kind === "merged" && (
        <ConfirmDialog
          title={t("chat.mergedTitle")}
          confirmLabel={t("chat.mergedConfirm")}
          onConfirm={() => {
            const { tabId } = worktreeDialog;
            setWorktreeDialog(null);
            discardWorktree(tabId).catch((e: unknown) =>
              showToast(`Cleanup failed: ${e instanceof Error ? e.message : e}`),
            );
          }}
          onCancel={() => setWorktreeDialog(null)}
        >
          {t("chat.mergedBody")}
        </ConfirmDialog>
      )}

      {worktreeDialog?.kind === "conflict" && (
        <ConfirmDialog
          title={t("chat.conflictTitle")}
          confirmLabel={t("action.confirm")}
          onConfirm={() => setWorktreeDialog(null)}
          onCancel={() => setWorktreeDialog(null)}
        >
          <p className="mb-2">
            {t("chat.conflictBody")}
          </p>
          <ul className="max-h-48 list-inside list-disc overflow-y-auto font-mono text-xs text-warn">
            {worktreeDialog.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-secondary">
            {t("chat.conflictHint")}
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
