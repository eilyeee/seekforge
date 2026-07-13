import { useEffect, useMemo, useRef, useState } from "react";
import { activeTab, useStore } from "../store";
import { api } from "../lib/api";
import { mapToServerTurn, userTurnOf } from "../lib/backtrack";
import { buildHandoff, handoffFilename } from "../lib/handoff";
import { ChatItems } from "../components/chat/ChatItems";
import { HomeWelcome } from "../components/chat/HomeWelcome";
import { Composer, type ComposerCommand } from "../components/chat/Composer";
import { LoopPanel } from "../components/chat/LoopPanel";
import { ModelBar } from "../components/chat/ModelBar";
import {
  CommandArgsDialog,
  commandHasShell,
  commandTakesArgs,
  expandCommand,
} from "../components/chat/CommandArgsDialog";
import { RunControls } from "../components/chat/RunControls";
import { PermissionModal } from "../components/chat/PermissionModal";
import { QuestionModal } from "../components/chat/QuestionModal";
import { TabBar } from "../components/chat/TabBar";
import { UsageFooter } from "../components/chat/UsageFooter";
import { useT } from "../lib/i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/ui";
import type { AccountBalance, ServerConfig, SlashCommand } from "../types";

/** Worktree dialog state: discard confirm, post-merge delete confirm, conflict report. */
type WorktreeDialog =
  | { kind: "discard"; tabId: string }
  | { kind: "merged"; tabId: string }
  | { kind: "conflict"; files: string[] };

type BacktrackTarget = {
  tabId: string;
  sessionId: string;
  workspaceId: string;
  itemId: number;
};

export function ChatView() {
  const t = useT();
  const tabsState = useStore((s) => s.tabs);
  const workspaces = useStore((s) => s.workspaces);
  const tab = activeTab(tabsState);
  const { sendTask, cancel, newSession, respondPermission, respondQuestion, connect } = useStore.getState();
  const { openTab, closeTab, setActiveTab, setMode, setApprovalMode, executePlan, setView } = useStore.getState();
  const { openWorktreeTab, mergeWorktree, discardWorktree } = useStore.getState();
  const { setModel, setThinking, setReasoningEffort, setOutputStyle, truncateAtItem, startLoop, resumeLoop } =
    useStore.getState();
  const workspaceName = (ws: string) => workspaces.find((w) => w.id === ws)?.name;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[tab.tabId] ?? "";
  const setDraft = (text: string) => setDrafts((d) => ({ ...d, [tab.tabId]: text }));

  // A seed from another view ("Ask this subagent") prefills the active tab once.
  const chatDraft = useStore((s) => s.chatDraft);
  const clearChatDraft = useStore((s) => s.clearChatDraft);
  useEffect(() => {
    if (chatDraft != null) {
      setDrafts((d) => ({ ...d, [tab.tabId]: chatDraft }));
      clearChatDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatDraft]);

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
    let alive = true;
    api
      .config(tab.ws)
      .then((value) => { if (alive) setConfig(value); })
      .catch(() => { if (alive) setConfig(null); });
    return () => { alive = false; };
  }, [tab.ws]);

  /** Account balance chip: fetched on mount and again after each run ends. */
  const [balance, setBalance] = useState<AccountBalance | null>(null);
  const running = tab.chat.running;
  useEffect(() => {
    if (running) return;
    let alive = true;
    api
      .balance(tab.ws)
      .then((r) => {
        // null = unknown; keep showing the previous value (fetchBalance contract).
        if (alive && r.balance) setBalance(r.balance);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [running, tab.ws]);

  /** Custom slash commands (GET /api/commands), merged into the composer palette. */
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  /** A parameterized custom command awaiting its arguments (the popup). */
  const [argsCommand, setArgsCommand] = useState<SlashCommand | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .commands(tab.ws)
      .then((r) => { if (alive) setCustomCommands(r.commands); })
      .catch(() => { if (alive) setCustomCommands([]); });
    return () => { alive = false; };
  }, [tab.ws]);

  /** Available output styles (GET /api/output-styles) for the ModelBar picker. */
  const [outputStyles, setOutputStyles] = useState<{ name: string; kind: "builtin" | "custom" }[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .outputStyles(tab.ws)
      .then((r) => { if (alive) setOutputStyles(r.styles); })
      .catch(() => { if (alive) setOutputStyles([]); });
    return () => { alive = false; };
  }, [tab.ws]);

  /** Manual /compact: POST the active tab's session, then refresh on success. */
  const compactSession = () => {
    const sessionId = tab.chat.sessionId;
    if (!sessionId) {
      showToast(t("chat.compactNoSession"));
      return;
    }
    api
      .sessionCompact(sessionId, tab.ws)
      .then(() => showToast(t("chat.compactDone")))
      .catch((e: unknown) => showToast(t("chat.compactError", { error: e instanceof Error ? e.message : String(e) })));
  };

  /** Backtrack dialog state (user item pending the rewind confirmation). */
  const [backtrackTarget, setBacktrackTarget] = useState<BacktrackTarget | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [backtrackError, setBacktrackError] = useState<string | null>(null);

  const confirmBacktrack = async () => {
    const target = backtrackTarget;
    setBacktrackTarget(null);
    if (!target) return;
    const originatingTab = useStore.getState().tabs.tabs.find((candidate) => candidate.tabId === target.tabId);
    if (originatingTab?.ws !== target.workspaceId || originatingTab.chat.sessionId !== target.sessionId) return;
    const local = userTurnOf(originatingTab.chat.items, target.itemId);
    if (!local) return;
    try {
      // Server turns index ALL user messages of messages.jsonl; align the
      // local bubble ordinal to them from the end (see lib/backtrack.ts).
      const turns = await api.sessionTurns(target.sessionId, target.workspaceId);
      const turn = mapToServerTurn(local.turn, local.count, turns.length);
      if (turn <= 0 || turn >= turns.length || !turns[turn]?.backtrackable) {
        throw new Error(`turn ${turn} is not backtrackable`);
      }
      const currentTab = useStore.getState().tabs.tabs.find((candidate) => candidate.tabId === target.tabId);
      if (currentTab?.ws !== target.workspaceId || currentTab.chat.sessionId !== target.sessionId) return;
      await api.backtrack(target.sessionId, turn, restoreFiles, target.workspaceId);
      truncateAtItem(target.tabId, target.sessionId, target.itemId);
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
    // "# fact" saves to project memory instead of sending a task (like Claude Code).
    if (task.startsWith("#")) {
      const fact = task.slice(1).trim();
      if (!fact) return;
      setDraft("");
      api
        .memoryAddFact(fact, "convention", undefined, undefined, tab.ws)
        .then(() => showToast(t("chat.memorySaved")))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err)));
      return;
    }
    sendTask(task);
    setDraft("");
  };

  // Resolve a chosen custom command into composer text. Bodies with a !`shell`
  // injection are expanded server-side (the shell runs in the workspace);
  // everything else interpolates args locally.
  const insertCommand = (c: SlashCommand, args: string): void => {
    if (commandHasShell(c.body)) {
      api
        .expandCommand(c.name, args, tab.ws)
        .then((r) => setDraft(r.text))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err)));
    } else {
      setDraft(expandCommand(c, args));
    }
  };

  // Slash-command registry for the composer palette: built-in UI/store actions,
  // the manual /compact action, and any project/user custom commands from the
  // server (choosing a custom command inserts its `body` into the draft).
  const tabMode = tab.mode;
  const composerCommands = useMemo<ComposerCommand[]>(() => {
    const builtins: ComposerCommand[] = [
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
      { name: "files", hint: t("chat.cmdFilesHint"), run: () => setView("files") },
      { name: "git", hint: t("chat.cmdGitHint"), run: () => setView("git") },
      { name: "skills", hint: t("chat.cmdSkillsHint"), run: () => setView("skills") },
      { name: "agents", hint: t("chat.cmdAgentsHint"), run: () => setView("agents") },
      { name: "memory", hint: t("chat.cmdMemoryHint"), run: () => setView("memory") },
      { name: "evolution", hint: t("chat.cmdEvolutionHint"), run: () => setView("evolution") },
      { name: "settings", hint: t("chat.cmdSettingsHint"), run: () => setView("settings") },
      { name: "compact", hint: t("chat.cmdCompactHint"), run: compactSession },
    ];
    // Custom commands take priority over built-ins on a name clash: drop the
    // shadowed built-in. Parameterized ones ($ARGUMENTS) open the args popup;
    // the rest insert their body straight into the composer draft.
    const customNames = new Set(customCommands.map((c) => c.name));
    const custom: ComposerCommand[] = customCommands.map((c) => ({
      name: c.name,
      hint: c.description,
      run: () => (commandTakesArgs(c.body) ? setArgsCommand(c) : insertCommand(c, "")),
    }));
    return [...builtins.filter((b) => !customNames.has(b.name)), ...custom];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSession, setMode, setView, tabMode, customCommands, compactSession]);

  const requestClose = (tabId: string) => {
    const target = tabsState.tabs.find((t) => t.tabId === tabId);
    if (target?.chat.running) setConfirmClose(tabId);
    else closeTab(tabId);
  };

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
          {tab.chat.sessionId && !tab.chat.running && (
            <Button size="sm" onClick={compactSession} title={t("chat.cmdCompactHint")}>
              {t("chat.compact")}
            </Button>
          )}
          <Button size="sm" onClick={newSession} disabled={tab.chat.running}>
            {t("chat.newSession")}
          </Button>
        </div>
      </header>

      <LoopPanel
        progress={tab.loop}
        running={tab.chat.running}
        loopRunning={tab.loopRunning}
        onRun={startLoop}
        onResume={resumeLoop}
        onStop={cancel}
      />

      <div
        ref={scrollRef}
        onScroll={(e) => scrollPos.current.set(tab.tabId, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-4 py-6"
      >
        {/* Codex-style centered conversation column. */}
        <div className="mx-auto w-full max-w-3xl">
          {tab.chat.items.length === 0 ? (
            <HomeWelcome
              onQuickAction={setDraft}
              onNavigate={setView}
              workspaceId={tab.ws}
            />
          ) : (
            <ChatItems
              items={tab.chat.items}
              onBacktrack={
                tab.chat.sessionId && !tab.chat.running
                  ? (itemId) => {
                      setRestoreFiles(false);
                      setBacktrackError(null);
                      setBacktrackTarget({
                        tabId: tab.tabId,
                        sessionId: tab.chat.sessionId!,
                        workspaceId: tab.ws,
                        itemId,
                      });
                    }
                  : undefined
              }
            />
          )}
        </div>
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

      {/* Codex-style centered input column under a full-width divider:
          model+thinking, composer, then the run-context controls. */}
      <div className="border-t border-subtle">
        <div className="mx-auto w-full max-w-3xl">
        <ModelBar
          tab={tab}
          config={config}
          outputStyles={outputStyles}
          onSetModel={setModel}
          onSetThinking={setThinking}
          onSetReasoningEffort={setReasoningEffort}
          onSetOutputStyle={setOutputStyle}
        />

        <Composer
          key={tab.tabId}
          value={draft}
          onChange={setDraft}
          onSend={submit}
          disabled={tab.chat.running}
          placeholder={tab.chat.running ? t("chat.composerRunningPlaceholder") : t("chat.composerPlaceholder", { slash: "/", at: "@" })}
          commands={composerCommands}
          workspaceId={tab.ws ?? ""}
        />

        <RunControls
          tab={tab}
          config={config}
          onSetMode={setMode}
          onSetApprovalMode={setApprovalMode}
          onSetSandbox={(value) => {
            const origin = { tabId: tab.tabId, workspaceId: tab.ws };
            void api.setConfig("sandbox", value, undefined, origin.workspaceId).then((next) => {
              const current = activeTab(useStore.getState().tabs);
              if (current.tabId === origin.tabId && current.ws === origin.workspaceId) setConfig(next);
            }).catch(() => {});
          }}
        />
        </div>
      </div>

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

      {backtrackTarget !== null && (
        <ConfirmDialog
          title={t("chat.backtrackTitle")}
          confirmLabel={t("chat.backtrackConfirm")}
          danger
          onConfirm={() => void confirmBacktrack()}
          onCancel={() => setBacktrackTarget(null)}
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

      {argsCommand && (
        <CommandArgsDialog
          command={argsCommand}
          onSubmit={(args) => {
            insertCommand(argsCommand, args);
            setArgsCommand(null);
          }}
          onCancel={() => setArgsCommand(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded border border-strong bg-surface-raised px-4 py-2 text-sm text-primary shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
