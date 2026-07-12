import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  addMemoryFact,
  approveMemoryCandidate,
  buildSessionAudit,
  renderSessionAuditMarkdown,
  compactSessionNow,
  createBackgroundTasks,
  listMemoryCandidates,
  listProjectFacts,
  listSessions,
  rejectMemoryCandidate,
  loadAgentDefinitions,
  projectMemoryPath,
  fetchBalance,
  forkSession,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  readMcpResource,
  readSessionMeta,
  rewindSession,
  rewindSessionToTurn,
  sessionTitle,
  truncateSessionAtUserTurn,
  writeSessionMeta,
  llmCompactSessionNow,
  createDeepSeekProvider,
  listGitWorktrees,
  isWorktreeDirty,
  isValidLoopId,
  createWorktree,
  worktreeBranchExists,
  removeWorktree,
  WorktreeGitError,
  BUILTIN_COMMAND_ALLOWLIST,
  type BackgroundTasks,
  type McpClientEntry,
  type McpPromptRef,
  type ToolSpec,
} from "@seekforge/core";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "./config.js";
import { configParseErrors, unknownConfigKeys } from "./config.js";
import {
  approvalModeFor,
  nextApproval,
  permissionResultForKey,
  type ChatAction,
  type ChatState,
  type Overlay,
} from "./model.js";
import { activeChat, activeTabId, initialTabs, tabLabels, tabsReducer } from "./tabs.js";
import { buildTree, moveCursor, toggleDir, visibleNodes, type TreeState } from "./file-tree.js";
import { Sidebar } from "./components/Sidebar.js";
import { pagerLines, pagerWindow } from "./pager-source.js";
import { Pager } from "./components/Pager.js";
import { ghostSuggestion } from "./suggestion.js";
import { stashList, stashPop, stashPush } from "./stash.js";
import { THEME_PRESETS, loadTheme, themePickerLines } from "./theme.js";
import { buildHandoff, handoffPath, latestHandoff, listHandoffs } from "./handoff.js";
import { formatUsageDetail, kfmt } from "./format.js";
import { COMMANDS, parseInput, type CommandSpec, type SlashCommand } from "./commands.js";
import { argCandidates, type ArgContext } from "./arg-values.js";
import { parseWorktreeCommand, pickFreeSlug, resolveWorktreeTarget, seekforgeWorktrees } from "./worktree-cmd.js";
import { bumpUsage, didYouMean, rankCommands, type CommandUsage } from "./command-rank.js";
import { helpRows, selectableIndices } from "./command-meta.js";
import {
  buildBugReport,
  findChangelogSection,
  formatConfigLines,
  formatHookLines,
  formatPermissionLines,
  formatReleaseNotes,
  formatStatusLines,
} from "./command-surfaces.js";
import { KEYMAP, resolveAction, toStroke, type Binding, type InkKey, type KeyStroke, type Scope } from "./keymap.js";
import { customCommandSpecs, expandCustomCommand, loadCustomCommands, type CustomCommand } from "./custom-commands.js";
import { captureClipboardImage, imagePlaceholder } from "./clipboard-image.js";
import { createPasteRegistry, expandPastes, registerPaste, shouldPlaceholder } from "./paste.js";
import {
  clearTerminalTitle,
  isMouseEvent,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  parseMouseWheel,
  setTerminalTitle,
} from "./terminal.js";
import { loadKeybindings, mergeKeymap } from "./keybindings.js";
import { modelPickerLines, modelsForProvider } from "./model-list.js";
import { addTodo, formatTodoLines, loadTodos, removeTodo, toggleTodo } from "./todos.js";
import { expandExtraFileRefs, formatExtraDirLines, normalizeExtraDir } from "./workspace-dirs.js";
import { initialSchedulerState, tick, type SchedulerState } from "./statusline-scheduler.js";
import { checkBudget, type BudgetState } from "./budget.js";
import { detectTerminal, terminalSetupInstructions } from "./terminal-setup.js";
import { keyHints, turnSummaryLine } from "./render-helpers.js";
import { t } from "./strings.js";
import { runSession } from "./agent/run-session.js";
import { resumeLoop, runLoop } from "./agent/run-loop.js";
import { formatLoopEvent } from "./loop-format.js";
import {
  atTokenAt,
  backspace,
  clearAll,
  deleteForward,
  emptyEditor,
  endsWithContinuation,
  insertText,
  isOnFirstLine,
  isOnLastLine,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  replaceAtToken,
  replaceSlashArg,
  setText,
  slashArgAt,
  slashPrefix,
  type EditorState,
} from "./editor.js";
import { appendHistory, createHistoryNav, loadHistory, type HistoryNav } from "./history.js";
import { fuzzyRank } from "./fuzzy.js";
import { bumpFrecency, loadFrecency, rankFiles, scanWorkspaceFiles, type Frecency } from "./files.js";
import { sessionAllowPrefix } from "./allowlist.js";
import { backtrackTargets } from "./backtrack.js";
import { formatCandidateLine, pendingCandidates, removeCandidateAt } from "./memory-candidates.js";
import { classifyUnifiedDiff } from "./diff.js";
import { configKeysCheck, configParseCheck, createDefaultProbes, formatDoctorLines, runDoctor } from "./doctor.js";
import { transcriptToMarkdown, defaultExportPath, auditExportPath } from "./export.js";
import { resolveMemoryEditTarget } from "./memory-path.js";
import {
  currentMatch,
  searchBackspace,
  searchInput,
  searchNext,
  startSearch,
  type HistorySearch,
} from "./history-search.js";
import { INIT_PROMPT } from "./init-prompt.js";
import { notify } from "./notify.js";
import { applyCompletion, cycleCompletion, startCompletion, type PathCompletion } from "./path-complete.js";
import { formatSkillLines, loadSkillsWithStatus } from "./skills-surface.js";
import { attachSkillContent, expandSkillCommand, findSkillByCommand, skillCommandSpecs } from "./skill-commands.js";
import { applyVimKey, initialVim, type VimState } from "./vim.js";
import { formatAgentLines, formatBgTaskLines, formatMcpLines, formatSessionLines } from "./surfaces.js";
import {
  findPromptByCommand,
  formatMcpPromptLines,
  mcpPromptCommandSpecs,
  promptArgsFromText,
} from "./mcp-prompt-commands.js";
import { openInExternalEditor } from "./external-editor.js";
import { copyToClipboard } from "./clipboard.js";
import { Header, ACCENT, setAccent } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { StatusBar } from "./components/StatusBar.js";
import { MultilineComposer } from "./components/MultilineComposer.js";
import { PermissionPanel } from "./components/PermissionPanel.js";
import { Palette } from "./components/Palette.js";
import { FilePicker } from "./components/FilePicker.js";
import { ContextInspector } from "./components/ContextInspector.js";
import { ListOverlay } from "./components/ListOverlay.js";
import { QuestionPanel } from "./components/QuestionPanel.js";

export type AppProps = {
  config: TuiConfig;
  projectPath: string;
  initialModel: string;
  mcpToolSpecs: ToolSpec[];
  /** Live MCP connections (resource listing / @mcp: references). */
  mcpEntries?: McpClientEntry[];
  /** Resume this session on launch (-c / --continue). */
  initialSessionId?: string;
  /** Package version, shown in the header. */
  version?: string;
  /** One dim line shown once on startup when a newer npm version exists. */
  updateNotice?: string;
};

type PendingPermission = {
  request: PermissionRequest;
  resolve: (result: ConfirmResult) => void;
};

/** Items scrolled per PageUp/PageDown press. */
const SCROLL_PAGE = 10;
/** Rendered transcript window (older items are virtualized away). */
const VIEW_ITEMS = 40;

const EXECUTE_PLAN_PROMPT =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";

export function App({
  config,
  projectPath,
  initialModel,
  mcpToolSpecs,
  mcpEntries = [],
  initialSessionId,
  version,
  updateNotice,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { setRawMode } = useStdin();
  // Multi-tab state: each tab owns a full ChatState; actions route by tab ID
  // so runs keep writing to their own tab after you switch away.
  const [tabsState, tabsDispatch] = useReducer(tabsReducer, undefined, () => initialTabs(initialModel));
  const state = activeChat(tabsState);
  const activeIdRef = useRef(activeTabId(tabsState));
  activeIdRef.current = activeTabId(tabsState);
  const dispatch = useCallback(
    (action: ChatAction) => tabsDispatch({ type: "chat", tabId: activeIdRef.current, action }),
    [],
  );
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  /** Hunk indices selected by the user for multi-hunk permission requests. */
  const [hunkSelection, setHunkSelection] = useState<number[]>([]);

  /**
   * When a new multi-hunk permission request arrives, reset selection to all
   * hunks (apply-all default). Single/no-hunk requests leave state unchanged
   * (the key-routing below ignores it).
   */
  useEffect(() => {
    const hunks = state.permission?.hunks;
    if (hunks && hunks.length > 1) {
      setHunkSelection(hunks.map((h) => h.index));
    }
  }, [state.permission]);

  // -c / --continue: chain onto the most recent session.
  useEffect(() => {
    if (initialSessionId) {
      dispatch({ type: "set-session", sessionId: initialSessionId });
      dispatch({ type: "notice", text: `continuing session ${initialSessionId} — your next message resumes it` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vim mode (off by default; /vim toggles, config.vim preseeds).
  const [vimOn, setVimOn] = useState(config.vim === true);
  const [vim, setVim] = useState<VimState>(initialVim());

  // Ctrl+R reverse history search; entries snapshotted when the search opens.
  const [search, setSearch] = useState<HistorySearch | null>(null);
  const searchEntriesRef = useRef<string[]>([]);

  // Tab path-completion cycling state (reset on any other edit).
  const completionRef = useRef<PathCompletion | null>(null);
  const lastEscRef = useRef(0);

  // Mutable refs hold values the async run loop reads after renders.
  const sessionIdRef = useRef<string | undefined>(undefined);
  sessionIdRef.current = state.sessionId;
  const modelRef = useRef(state.model);
  modelRef.current = state.model;
  const approvalRef = useRef(state.approval);
  approvalRef.current = state.approval;
  const stateRef = useRef(state);
  stateRef.current = state;
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;

  // Per-tab foreground run state: each tab can run its own task; Esc/Ctrl+C
  // and prompt keys always act on the ACTIVE tab's entries only.
  const runsByTabRef = useRef<Map<number, { controller: AbortController; runId: number }>>(new Map());
  const pendingPermissionByTabRef = useRef<Map<number, PendingPermission>>(new Map());
  const pendingQuestionByTabRef = useRef<Map<number, (answer: string) => void>>(new Map());
  const sigintCountRef = useRef(0);

  // Ctrl+B run detachment: ids of runs sent to the background, their
  // controllers (aborted on quit), and the per-run id counter.
  const runIdCounterRef = useRef(0);
  const detachedRunsRef = useRef<Set<number>>(new Set());
  const detachedControllersRef = useRef<Map<number, AbortController>>(new Map());

  // Active-tab views over the per-tab maps (legacy single-tab call sites).
  const controllerRef = {
    get current(): AbortController | null {
      return runsByTabRef.current.get(activeIdRef.current)?.controller ?? null;
    },
  };
  const pendingPermissionRef = {
    get current(): PendingPermission | null {
      return pendingPermissionByTabRef.current.get(activeIdRef.current) ?? null;
    },
  };
  const pendingQuestionRef = {
    get current(): ((answer: string) => void) | null {
      return pendingQuestionByTabRef.current.get(activeIdRef.current) ?? null;
    },
  };

  // Large-paste placeholders and clipboard-image attachments.
  const pasteRegistryRef = useRef(createPasteRegistry());
  const imageCounterRef = useRef(0);

  // User keybinding overrides merged over the built-in table, once.
  const keymapTableRef = useRef<Binding[] | null>(null);
  if (keymapTableRef.current === null) {
    keymapTableRef.current = mergeKeymap(KEYMAP, loadKeybindings(projectPath));
  }
  const keys = useCallback(
    (scope: Scope, stroke: KeyStroke) => resolveAction(scope, stroke, keymapTableRef.current ?? KEYMAP),
    [],
  );

  // Custom slash commands (.seekforge/commands/*.md), loaded once.
  const customCommandsRef = useRef<CustomCommand[] | null>(null);
  if (customCommandsRef.current === null) customCommandsRef.current = loadCustomCommands(projectPath);

  // Installed skills double as "/skill:<id>" palette commands.
  const skillRowsRef = useRef<ReturnType<typeof loadSkillsWithStatus> | null>(null);
  if (skillRowsRef.current === null) skillRowsRef.current = loadSkillsWithStatus(projectPath);
  const appStartRef = useRef(Date.now());

  // MCP prompts double as "/mcp:<server>:<prompt>" palette commands. Fetched
  // lazily once on mount (prompts/list per server) into a ref; a state bump
  // re-renders the palette once they arrive. Empty/no servers → stays [].
  const mcpPromptsRef = useRef<McpPromptRef[]>([]);
  const [mcpPromptsLoaded, setMcpPromptsLoaded] = useState(false);
  useEffect(() => {
    if (mcpEntries.length === 0) return;
    let cancelled = false;
    void listMcpPrompts(mcpEntries)
      .then((prompts) => {
        if (cancelled) return;
        mcpPromptsRef.current = prompts;
        setMcpPromptsLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mcpEntries]);

  // Extra read-only roots for @ references (/add-dir).
  const extraDirsRef = useRef<string[]>([]);
  // Palette ranking: commands used this session float to the top.
  const usageRef = useRef<CommandUsage>({});
  // Sidebar file tree (Ctrl+E): null = hidden; focused steals ↑↓/Enter.
  const [sidebar, setSidebar] = useState<(TreeState & { focused: boolean }) | null>(null);
  // Transcript pager (Ctrl+L): offset from the top of the full plain text.
  const [pager, setPager] = useState<{ lines: string[]; offset: number } | null>(null);
  const versionRef = useRef(version);
  const lastErrorRef = useRef<string | null>(null);
  // Cost-budget warning state (80% / 100%, warned once each).
  const budgetRef = useRef<BudgetState>({ warned80: false, warnedOver: false });
  // Custom statusline output (config.statusLine command). Throttled + cached
  // by a scheduler so we never spawn the process on every render; recomputed
  // on state change and on a light interval, off the render path.
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const statusLineSchedRef = useRef<SchedulerState>(initialSchedulerState);

  // "Allow for the session" pushes prefixes into this array IN PLACE: the
  // same reference flows into the dispatcher policy, so additions apply to
  // the currently running task too.
  const allowlistRef = useRef<string[]>([...(config.commandAllowlist ?? [])]);
  const runConfigRef = useRef<TuiConfig>({ ...config, commandAllowlist: allowlistRef.current });

  // One background-task manager for the whole TUI process: tasks started by
  // any turn (dev servers, watchers) survive across runs; killed on exit.
  const bgRef = useRef<BackgroundTasks | null>(null);
  if (bgRef.current === null) bgRef.current = createBackgroundTasks();

  const syncBg = useCallback(() => {
    const tasks = (bgRef.current?.list() ?? []).map((t) => ({ id: t.id, command: t.command, status: t.status }));
    dispatch({ type: "bg-sync", tasks });
  }, []);

  const quit = useCallback(() => {
    for (const c of detachedControllersRef.current.values()) c.abort();
    detachedControllersRef.current.clear();
    for (const r of runsByTabRef.current.values()) r.controller.abort();
    runsByTabRef.current.clear();
    bgRef.current?.disposeAll();
    process.stdout.write(MOUSE_DISABLE);
    clearTerminalTitle();
    exit();
  }, [exit]);

  // Mouse capture is OFF by default so native text selection keeps working
  // (Claude Code behaves the same); "/mouse" or `"mouse": true` enables
  // wheel-scrolling of the transcript instead.
  const [mouseOn, setMouseOn] = useState(config.mouse === true);
  useEffect(() => {
    process.stdout.write(mouseOn ? MOUSE_ENABLE : MOUSE_DISABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
      clearTerminalTitle();
    };
  }, [mouseOn]);
  useEffect(() => {
    const name = projectPath.split("/").filter(Boolean).pop() ?? "seekforge";
    setTerminalTitle(`seekforge — ${name}${state.running ? " ⚙" : ""}`);
  }, [projectPath, state.running]);

  // Custom statusline driver: when config.statusLine is set, recompute via the
  // throttled scheduler on relevant state changes and on a light interval. The
  // spawnSync runs inside setImmediate (off the render path) and is guarded so
  // at most one is in flight; the scheduler caps the spawn rate independently.
  const statusLineBusyRef = useRef(false);
  useEffect(() => {
    if (!config.statusLine) return;
    const command = config.statusLine;
    const compute = (): void => {
      if (statusLineBusyRef.current) return;
      statusLineBusyRef.current = true;
      setImmediate(() => {
        try {
          const s = stateRef.current;
          const result = tick(statusLineSchedRef.current, command, {
            model: modelRef.current,
            cwd: projectPath,
            ...(s.sessionId ? { sessionId: s.sessionId } : {}),
            costUsd: s.totalUsage.costUsd,
            approval: s.approval,
            totalTokens: s.totalUsage.promptTokens + s.totalUsage.completionTokens,
            ...(s.context ? { contextPercent: s.context.percent } : {}),
          });
          statusLineSchedRef.current = result.state;
          if (result.recomputed) setStatusLineText(result.state.lastOutput);
        } finally {
          statusLineBusyRef.current = false;
        }
      });
    };
    compute();
    const id = setInterval(compute, 5000);
    return () => clearInterval(id);
  }, [
    config.statusLine,
    projectPath,
    state.model,
    state.approval,
    state.sessionId,
    state.totalUsage,
    state.context,
  ]);

  // Ctrl+Z suspend: restore the terminal, stop, and re-enter raw mode on fg.
  useEffect(() => {
    const onCont = (): void => {
      setRawMode(true);
      if (mouseOn) process.stdout.write(MOUSE_ENABLE);
    };
    process.on("SIGCONT", onCont);
    return () => {
      process.removeListener("SIGCONT", onCont);
    };
  }, [setRawMode, mouseOn]);

  const suspend = useCallback(() => {
    setRawMode(false);
    process.stdout.write(MOUSE_DISABLE);
    process.kill(process.pid, "SIGTSTP");
  }, [setRawMode]);

  const notice = useCallback((text: string, tone?: "dim" | "error") => {
    dispatch(tone ? { type: "notice", text, tone } : { type: "notice", text });
  }, []);

  // Surface a "newer version available" line once on startup (dim, non-blocking).
  // Fires when the async check resolves and the prop arrives via re-render.
  useEffect(() => {
    if (updateNotice) notice(updateNotice, "dim");
  }, [updateNotice, notice]);

  /** OS notification + terminal bell (config.notify / config.bell gate each). */
  const ring = useCallback(
    (body?: string) => {
      if (config.notify !== false && body) {
        notify("SeekForge", body, { bell: config.bell !== false });
      } else if (config.bell !== false) {
        process.stdout.write("\x07");
      }
    },
    [config.notify, config.bell],
  );

  // Composer history, persisted across sessions.
  const historyFile = useMemo(() => join(projectPath, ".seekforge", "tui-history"), [projectPath]);
  const historyNavRef = useRef<HistoryNav | null>(null);
  const historyEntriesRef = useRef<string[]>([]);
  if (historyNavRef.current === null) {
    historyEntriesRef.current = loadHistory(historyFile);
    historyNavRef.current = createHistoryNav(historyEntriesRef.current);
  }

  // Workspace file index for the @ picker (scanned lazily, once).
  const filesRef = useRef<string[] | null>(null);
  const frecencyRef = useRef<Frecency | null>(null);
  const ensureFiles = useCallback((): string[] => {
    if (filesRef.current === null) filesRef.current = scanWorkspaceFiles(projectPath);
    if (frecencyRef.current === null) frecencyRef.current = loadFrecency(projectPath);
    return filesRef.current;
  }, [projectPath]);

  // ---------------------------------------------------------------------
  // Overlay derivation: composer text drives the palette / file picker.
  // ---------------------------------------------------------------------

  /** Data for the slash-argument picker, gathered when it opens. */
  const buildArgContext = useCallback((): ArgContext => {
    const metas = listSessions(projectPath).slice(0, 20);
    return {
      sessions: metas.map((m) => ({ id: m.id, title: sessionTitle(projectPath, m.id), status: m.status })),
      todos: loadTodos(projectPath),
      bgTasks: (bgRef.current?.list() ?? []).map((t) => ({ id: t.id, command: t.command, status: t.status })),
      models: [...modelsForProvider(config.provider)],
      memoryFactCount: listProjectFacts(projectPath).length,
      memoryFiles: (() => {
        try {
          return readdirSync(dirname(projectMemoryPath(projectPath))).filter((f) => !f.startsWith("."));
        } catch {
          return [];
        }
      })(),
    };
  }, [projectPath]);

  const syncOverlay = useCallback(
    (next: EditorState) => {
      const current = stateRef.current.overlay;
      if (current?.kind === "context" || current?.kind === "help") return; // modal; close via Esc only
      const slash = slashPrefix(next);
      if (slash !== null) {
        const index = current?.kind === "palette" && current.query === slash ? current.index : 0;
        dispatch({ type: "overlay", overlay: { kind: "palette", query: slash, index } });
        return;
      }
      // Argument picker: "/resume <cursor>" lists sessions, "/think " modes…
      const slashArg = slashArgAt(next);
      if (slashArg) {
        const all = argCandidates(slashArg.name, slashArg.arg, buildArgContext());
        if (all && all.length > 0) {
          const candidates = slashArg.arg
            ? fuzzyRank(slashArg.arg, all.filter((c) => c.value !== ""), (c) => c.value, 10)
            : all.slice(0, 10);
          if (candidates.length > 0) {
            const keep =
              current?.kind === "args" && current.command === slashArg.name && current.index < candidates.length
                ? current.index
                : 0;
            dispatch({
              type: "overlay",
              overlay: { kind: "args", command: slashArg.name, anchor: slashArg.anchor, candidates, index: keep },
            });
            return;
          }
        }
        if (current) dispatch({ type: "overlay", overlay: null });
        return;
      }
      const at = atTokenAt(next);
      if (at) {
        ensureFiles();
        const index = current?.kind === "files" && current.query === at.query ? current.index : 0;
        dispatch({ type: "overlay", overlay: { kind: "files", query: at.query, index, anchor: at.anchor } });
        return;
      }
      if (current) dispatch({ type: "overlay", overlay: null });
    },
    [ensureFiles, buildArgContext],
  );

  const applyEditor = useCallback(
    (next: EditorState) => {
      completionRef.current = null; // any edit invalidates Tab-cycling
      setEditor(next);
      syncOverlay(next);
    },
    [syncOverlay],
  );

  // Derived overlay candidate lists (recomputed per render; lists are small).
  const paletteCommands = useMemo(() => {
    if (state.overlay?.kind !== "palette") return [];
    const all: CommandSpec[] = [
      ...COMMANDS,
      ...customCommandSpecs(customCommandsRef.current ?? []).map((c) => ({ ...c, group: "tools" as const })),
      ...skillCommandSpecs(skillRowsRef.current ?? []),
      ...mcpPromptCommandSpecs(mcpPromptsRef.current),
    ];
    return rankCommands(state.overlay.query, all, usageRef.current, 24);
  }, [state.overlay, mcpPromptsLoaded]);

  const pickerFiles = useMemo(() => {
    if (state.overlay?.kind !== "files") return [];
    return rankFiles(state.overlay.query, filesRef.current ?? [], frecencyRef.current ?? {}, 10);
  }, [state.overlay]);

  // ---------------------------------------------------------------------
  // Running a task.
  // ---------------------------------------------------------------------

  const runTask = useCallback(
    async (task: string, opts?: { mode?: "ask" | "edit"; plan?: boolean; echoUser?: boolean }) => {
      const controller = new AbortController();
      const runId = ++runIdCounterRef.current;
      // The run belongs to the tab it started in: every dispatch below
      // routes there by ID, surviving tab switches.
      const runTabId = activeIdRef.current;
      const dispatchTab = (action: ChatAction): void => tabsDispatch({ type: "chat", tabId: runTabId, action });
      const tabChat = (): ChatState =>
        tabsStateRef.current.tabs.find((t) => t.id === runTabId)?.chat ?? stateRef.current;
      const label = task.replace(/\s+/g, " ").slice(0, 48);
      const detached = (): boolean => detachedRunsRef.current.has(runId);
      // Detached runs stay silent except for their final outcome.
      const dispatchRun = (a: ChatAction): void => {
        if (!detached()) {
          dispatchTab(a);
          return;
        }
        if (a.type === "event" && a.event.type === "session.completed") {
          const summary = a.event.report.summary.split("\n")[0] ?? "done";
          dispatchTab({ type: "notice", text: `⚒ background task done: ${summary.slice(0, 100)}` });
        } else if (a.type === "event" && a.event.type === "session.failed") {
          dispatchTab({ type: "notice", tone: "error", text: `⚒ background task failed: ${a.event.error.message}` });
        }
      };
      runsByTabRef.current.set(runTabId, { controller, runId });
      sigintCountRef.current = 0;
      // The session this run owns: detaching frees the UI's sessionId for a
      // fresh session, so the run must keep resolving its own.
      const ownSessionId = { current: tabChat().sessionId };
      const startedAt = Date.now();
      const costBefore = tabChat().totalUsage.costUsd;
      if (opts?.echoUser !== false) dispatchTab({ type: "user", text: task });
      dispatchTab({ type: "run-start" });
      try {
        // Inline @mcp:server:uri resource references (max 5 per message).
        const mcpRefs = [...task.matchAll(/@mcp:([A-Za-z0-9_-]+):(\S+)/g)].slice(0, 5);
        for (const m of mcpRefs) {
          const [, server, uri] = m;
          if (!server || !uri) continue;
          try {
            const text = await readMcpResource(server, uri, mcpEntries);
            task += `\n\n--- MCP resource ${server}:${uri} ---\n${text}`;
          } catch (err) {
            dispatchTab({
              type: "notice",
              tone: "error",
              text: `mcp resource ${server}:${uri} failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        await runSession(task, controller.signal, {
          config: runConfigRef.current,
          model: modelRef.current,
          projectPath,
          mcpToolSpecs,
          mode: opts?.mode ?? "edit",
          plan: opts?.plan ?? false,
          approvalMode: approvalModeFor(approvalRef.current),
          background: bgRef.current as BackgroundTasks,
          dispatch: (a: ChatAction) => {
            if (a.type === "event" && a.event.type === "session.created") ownSessionId.current = a.event.sessionId;
            dispatchRun(a);
          },
          getSessionId: () => ownSessionId.current,
          confirm: (req) =>
            new Promise<ConfirmResult>((resolve) => {
              if (detached()) {
                dispatchTab({
                  type: "notice",
                  tone: "error",
                  text: `⚒ background task asked permission for ${req.toolName} — denied (foreground only)`,
                });
                resolve(false);
                return;
              }
              pendingPermissionByTabRef.current.set(runTabId, { request: req, resolve });
              dispatchTab({ type: "permission", request: req });
              ring(`Permission needed: ${req.toolName}${req.command ? ` — ${req.command.slice(0, 60)}` : ""}`);
            }),
          askUser: (q) =>
            new Promise<string>((resolve) => {
              if (detached()) {
                resolve("(no answer — the session was moved to the background)");
                return;
              }
              pendingQuestionByTabRef.current.set(runTabId, resolve);
              dispatchTab({
                type: "overlay",
                overlay: { kind: "question", question: q.question, options: [...q.options], index: 0 },
              });
              ring(`Question: ${q.question.slice(0, 60)}`);
            }),
        });
        if (opts?.plan && !controller.signal.aborted && !detached()) {
          dispatchTab({ type: "plan-pending", pending: true });
          dispatchTab({ type: "notice", text: "Execute this plan? press y to run it, any other key to keep planning" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastErrorRef.current = message;
        if (!controller.signal.aborted && !detached()) {
          dispatchTab({ type: "notice", tone: "error", text: `error: ${message}` });
        }
      } finally {
        // If a permission prompt was still open when the run ended, deny it.
        const stalePerm = pendingPermissionByTabRef.current.get(runTabId);
        if (stalePerm) {
          stalePerm.resolve(false);
          pendingPermissionByTabRef.current.delete(runTabId);
          dispatchTab({ type: "permission-resolved" });
        }
        if (detached()) {
          detachedRunsRef.current.delete(runId);
          detachedControllersRef.current.delete(runId);
          dispatchTab({ type: "run-detach-done", runId });
        } else {
          if (runsByTabRef.current.get(runTabId)?.runId === runId) {
            runsByTabRef.current.delete(runTabId);
          }
          dispatchTab({ type: "run-end" });
          // Turn summary + budget + custom statusline (foreground runs only).
          if (!controller.signal.aborted) {
            const s = tabChat();
            dispatchTab({
              type: "notice",
              text: turnSummaryLine({
                durationMs: Date.now() - startedAt,
                costUsd: Math.max(0, s.totalUsage.costUsd - costBefore),
                totalTokens: s.turnTokens,
              }),
            });
            const budget = checkBudget(budgetRef.current, s.totalUsage.costUsd, config.costBudgetUsd);
            budgetRef.current = budget.state;
            if (budget.warning) dispatchTab({ type: "notice", tone: "error", text: budget.warning });
          }
        }
        syncBg();
        ring(`Task finished: ${task.slice(0, 60)}`);
      }
    },
    [projectPath, mcpToolSpecs, syncBg, ring, config.costBudgetUsd],
  );

  /**
   * Runs an autonomous run→verify loop (CORE's runAutoLoop) in the active tab.
   * Registers its controller in runsByTabRef so Esc / Ctrl+C abort it exactly
   * like a normal turn; streams each LoopEvent into the tab's transcript as
   * notices. The loop forces acceptEdits internally (see run-loop.ts).
   */
  const runLoopTask = useCallback(
    async (
      task: string,
      verifyCommand: string,
      options: { maxIterations?: number; costBudgetUsd?: number } = {},
    ) => {
      const controller = new AbortController();
      const runId = ++runIdCounterRef.current;
      const runTabId = activeIdRef.current;
      const dispatchTab = (action: ChatAction): void => tabsDispatch({ type: "chat", tabId: runTabId, action });
      runsByTabRef.current.set(runTabId, { controller, runId });
      const ownsRun = (): boolean => runsByTabRef.current.get(runTabId)?.runId === runId;
      const detached = (): boolean => detachedRunsRef.current.has(runId);
      sigintCountRef.current = 0;
      dispatchTab({ type: "user", text: `/loop ${verifyCommand}` });
      dispatchTab({ type: "notice", text: `loop task: ${task.replace(/\s+/g, " ").slice(0, 120)}` });
      dispatchTab({ type: "run-start" });
      try {
        const result = await runLoop(task, verifyCommand, controller.signal, {
          config: runConfigRef.current,
          model: modelRef.current,
          projectPath,
          mcpToolSpecs,
          maxIterations: options.maxIterations ?? 8,
          ...(options.costBudgetUsd !== undefined ? { costBudgetUsd: options.costBudgetUsd } : {}),
          onEvent: (event) => {
            if (!ownsRun()) return;
            for (const line of formatLoopEvent(event)) {
              dispatchTab({ type: "notice", text: line.text, tone: line.tone });
            }
          },
        });
        // Adopt the loop's session so a follow-up message resumes it.
        if (result.sessionId && ownsRun()) dispatchTab({ type: "set-session", sessionId: result.sessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ownsRun()) lastErrorRef.current = message;
        if (ownsRun() && !controller.signal.aborted) {
          dispatchTab({ type: "notice", tone: "error", text: `loop error: ${message}` });
        }
      } finally {
        if (detached()) {
          detachedRunsRef.current.delete(runId);
          detachedControllersRef.current.delete(runId);
          dispatchTab({ type: "run-detach-done", runId });
          syncBg();
          ring(`Loop finished: ${verifyCommand.slice(0, 60)}`);
        } else if (ownsRun()) {
          runsByTabRef.current.delete(runTabId);
          dispatchTab({ type: "run-end" });
          syncBg();
          ring(`Loop finished: ${verifyCommand.slice(0, 60)}`);
        }
      }
    },
    [projectPath, mcpToolSpecs, syncBg, ring],
  );

  const resumeLoopTask = useCallback(
    async (loopId: string, options: { addedIterations?: number; addedCostBudgetUsd?: number } = {}) => {
      const controller = new AbortController();
      const runId = ++runIdCounterRef.current;
      const runTabId = activeIdRef.current;
      const dispatchTab = (action: ChatAction): void => tabsDispatch({ type: "chat", tabId: runTabId, action });
      runsByTabRef.current.set(runTabId, { controller, runId });
      const ownsRun = (): boolean => runsByTabRef.current.get(runTabId)?.runId === runId;
      const detached = (): boolean => detachedRunsRef.current.has(runId);
      sigintCountRef.current = 0;
      dispatchTab({ type: "user", text: `/loop-resume ${loopId}` });
      dispatchTab({ type: "run-start" });
      try {
        const result = await resumeLoop(loopId, controller.signal, {
          config: runConfigRef.current,
          model: modelRef.current,
          projectPath,
          mcpToolSpecs,
          ...options,
          onEvent: (event) => {
            if (!ownsRun()) return;
            for (const line of formatLoopEvent(event)) dispatchTab({ type: "notice", text: line.text, tone: line.tone });
          },
        });
        if (result.sessionId && ownsRun()) dispatchTab({ type: "set-session", sessionId: result.sessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ownsRun()) lastErrorRef.current = message;
        if (ownsRun() && !controller.signal.aborted) dispatchTab({ type: "notice", tone: "error", text: `loop error: ${message}` });
      } finally {
        if (detached()) {
          detachedRunsRef.current.delete(runId);
          detachedControllersRef.current.delete(runId);
          dispatchTab({ type: "run-detach-done", runId });
          syncBg();
          ring(`Loop finished: ${loopId.slice(0, 60)}`);
        } else if (ownsRun()) {
          runsByTabRef.current.delete(runTabId);
          dispatchTab({ type: "run-end" });
          syncBg();
          ring(`Loop finished: ${loopId.slice(0, 60)}`);
        }
      }
    },
    [projectPath, mcpToolSpecs, syncBg, ring],
  );

  /** Ctrl+B: detach the ACTIVE tab's run; its chat continues in a fresh session. */
  const detachRun = useCallback(() => {
    const tabId = activeIdRef.current;
    const entry = runsByTabRef.current.get(tabId);
    if (!entry) {
      notice("nothing to detach — no task is running in this tab");
      return;
    }
    detachedRunsRef.current.add(entry.runId);
    detachedControllersRef.current.set(entry.runId, entry.controller);
    runsByTabRef.current.delete(tabId);
    // A pending permission would block the detached run forever: deny it now.
    const perm = pendingPermissionByTabRef.current.get(tabId);
    if (perm) {
      perm.resolve(false);
      pendingPermissionByTabRef.current.delete(tabId);
      dispatch({ type: "permission-resolved" });
    }
    const q = pendingQuestionByTabRef.current.get(tabId);
    if (q) {
      q("(no answer — the session was moved to the background)");
      pendingQuestionByTabRef.current.delete(tabId);
      dispatch({ type: "overlay", overlay: null });
    }
    dispatch({ type: "run-detach", runId: entry.runId, label: "task" });
  }, [notice, dispatch]);

  const submitTask = useCallback(
    (task: string) => {
      // Inline files referenced from /add-dir extra roots (workspace-level
      // @ expansion happens inside run-session).
      const expanded = extraDirsRef.current.length > 0 ? expandExtraFileRefs(task, extraDirsRef.current) : task;
      if (approvalRef.current === "plan") {
        void runTask(expanded, { mode: "ask", plan: true });
      } else {
        void runTask(expanded);
      }
    },
    [runTask],
  );

  // ---------------------------------------------------------------------
  // Slash commands.
  // ---------------------------------------------------------------------

  const openExternalEditor = useCallback(() => {
    setRawMode(false);
    const result = openInExternalEditor(editor.text);
    setRawMode(true);
    if (result.ok) {
      applyEditor(setText(result.text.replace(/\n+$/, "")));
    } else {
      notice(`editor failed: ${result.error}`, "error");
    }
  }, [editor.text, setRawMode, applyEditor, notice]);

  const handleSlash = useCallback(
    (command: SlashCommand) => {
      if (command.name !== "unknown") usageRef.current = bumpUsage(usageRef.current, command.name);
      switch (command.name) {
        case "help": {
          const specs: CommandSpec[] = [
            ...COMMANDS,
            ...customCommandSpecs(customCommandsRef.current ?? []).map((c) => ({ ...c, group: "tools" as const })),
            ...skillCommandSpecs(skillRowsRef.current ?? []),
            ...mcpPromptCommandSpecs(mcpPromptsRef.current),
          ];
          const rows = helpRows(specs);
          const selectable = selectableIndices(rows);
          dispatch({
            type: "overlay",
            overlay: {
              kind: "help",
              lines: rows.map((r) => (r.kind === "header" ? r.text : `  ${r.label.padEnd(26)} ${r.summary}`)),
              selectable,
              names: rows.filter((r) => r.kind === "command").map((r) => (r.kind === "command" ? r.name : "")),
              index: 0,
            },
          });
          break;
        }
        case "new":
          dispatch({ type: "new-session" });
          syncBg();
          notice("next message starts a fresh session");
          break;
        case "clear": {
          // "/clear <name>" labels the old session so /sessions shows it.
          const oldId = sessionIdRef.current;
          if (command.arg && oldId) {
            const meta = readSessionMeta(projectPath, oldId);
            if (meta) writeSessionMeta(projectPath, { ...meta, task: command.arg });
          }
          dispatch({ type: "clear" });
          syncBg();
          notice(
            command.arg && oldId
              ? `transcript cleared — old session labeled "${command.arg}" (see /sessions)`
              : "transcript cleared — next message starts a fresh session",
          );
          break;
        }
        case "sessions": {
          const metas = listSessions(projectPath);
          if (metas.length === 0) {
            notice("no sessions yet");
            break;
          }
          // Display titles (summary first line when available) instead of raw tasks.
          const titled = metas.map((m) => ({ ...m, task: sessionTitle(projectPath, m.id) }));
          dispatch({
            type: "overlay",
            overlay: {
              kind: "sessions",
              ids: metas.map((m) => m.id),
              lines: formatSessionLines(titled, 50),
              index: 0,
            },
          });
          break;
        }
        case "resume": {
          if (!command.arg || !readSessionMeta(projectPath, command.arg)) {
            notice("usage: /resume <session-id> (see /sessions)", "error");
            break;
          }
          dispatch({ type: "set-session", sessionId: command.arg });
          notice(`continuing session ${command.arg} — your next message resumes it`);
          break;
        }
        case "plan":
          if (!command.arg) {
            notice("usage: /plan <task>", "error");
            break;
          }
          if (controllerRef.current) {
            notice("a task is already running — Esc cancels it, or wait for it to finish", "error");
            break;
          }
          void runTask(command.arg, { mode: "ask", plan: true });
          break;
        case "loop": {
          if (controllerRef.current) {
            notice("a task is already running — Esc cancels it, or wait for it to finish", "error");
            break;
          }
          if (command.error) {
            notice(`invalid /loop options: ${command.error}`, "error");
            break;
          }
          const verifyCommand = command.verify?.trim();
          const task = command.task?.trim();
          if (!verifyCommand) {
            notice(
              "usage: /loop <verify command> — put the task on the line(s) below (Shift+Enter for a newline)",
              "error",
            );
            break;
          }
          if (!task) {
            notice(
              "add the task on the line(s) below the /loop command — the composer text is the task",
              "error",
            );
            break;
          }
          void runLoopTask(task, verifyCommand, {
            ...(command.maxIterations !== undefined ? { maxIterations: command.maxIterations } : {}),
            ...(command.costBudgetUsd !== undefined ? { costBudgetUsd: command.costBudgetUsd } : {}),
          });
          break;
        }
        case "loop-resume": {
          if (controllerRef.current) {
            notice("a task is already running — Esc cancels it, or wait for it to finish", "error");
            break;
          }
          if (command.error) {
            notice(`invalid /loop-resume options: ${command.error}`, "error");
            break;
          }
          if (!command.loopId || !isValidLoopId(command.loopId)) {
            notice("usage: /loop-resume [--add-iterations N] [--add-budget USD] <loop-id>", "error");
            break;
          }
          void resumeLoopTask(command.loopId, {
            ...(command.addedIterations !== undefined ? { addedIterations: command.addedIterations } : {}),
            ...(command.addedCostBudgetUsd !== undefined ? { addedCostBudgetUsd: command.addedCostBudgetUsd } : {}),
          });
          break;
        }
        case "approve": {
          if (!command.arg) {
            notice(`approval mode: ${approvalRef.current} (confirm | acceptEdits | auto | plan — Shift+Tab cycles)`);
            break;
          }
          if (
            command.arg === "auto" ||
            command.arg === "acceptEdits" ||
            command.arg === "confirm" ||
            command.arg === "plan"
          ) {
            dispatch({ type: "set-approval", approval: command.arg });
            notice(`approval mode: ${command.arg}`);
          } else {
            notice("usage: /approve [confirm|acceptEdits|auto|plan]", "error");
          }
          break;
        }
        case "rewind": {
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            notice("no active session to rewind", "error");
            break;
          }
          const apply = command.arg === "yes";
          const result = rewindSession(projectPath, sessionId, { dryRun: !apply });
          const total = result.restored.length + result.deleted.length;
          if (total === 0 && result.skipped.length === 0) {
            notice("nothing to rewind — this session made no file changes");
            break;
          }
          for (const p of result.restored.slice(0, 10)) notice(`  ${apply ? "restored" : "would restore"} ${p}`);
          for (const p of result.deleted.slice(0, 10)) notice(`  ${apply ? "deleted" : "would delete"} ${p}`);
          for (const s of result.skipped.slice(0, 10)) notice(`  skipped ${s.path}: ${s.reason}`, "error");
          if (!apply && total > 0) notice("run /rewind yes to apply");
          notice("(/rewind restores files; Esc Esc or /backtrack rewinds the conversation)");
          break;
        }
        case "model":
          if (!command.arg) {
            const models = modelsForProvider(config.provider);
            dispatch({
              type: "overlay",
              overlay: {
                kind: "model",
                ids: models.map((m) => m.id),
                lines: modelPickerLines(models, modelRef.current),
                index: Math.max(0, models.findIndex((m) => m.id === modelRef.current)),
              },
            });
          } else if (command.arg === "deepseek-reasoner") {
            notice("deepseek-reasoner has no tool calling and cannot drive the agent", "error");
          } else {
            dispatch({ type: "set-model", model: command.arg });
            notice(`model: ${command.arg}`);
          }
          break;
        case "remember": {
          if (!command.arg) {
            notice("usage: /remember <fact>  (or: # <fact>)", "error");
            break;
          }
          try {
            const c = addMemoryFact(projectPath, { content: command.arg, type: "convention" });
            notice(`remembered → project.md: ${c.content}`);
          } catch (err) {
            notice(`error: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          break;
        }
        case "tasks": {
          const mgr = bgRef.current as BackgroundTasks;
          const [verb, taskId] = (command.arg ?? "").split(/\s+/);
          if (verb === "kill" && taskId) {
            const killed = mgr.kill(taskId);
            notice(killed ? `killed ${taskId}` : `unknown task ${taskId}`, killed ? "dim" : "error");
            syncBg();
            break;
          }
          syncBg();
          const live = mgr.list().map((t) => ({ id: t.id, command: t.command, status: t.status }));
          for (const line of formatBgTaskLines(live)) notice(line);
          if (live.some((t) => t.status === "running")) notice("  /tasks kill <id> stops one; all are killed on exit");
          break;
        }
        case "memory": {
          if (command.arg?.startsWith("candidates")) {
            // "/memory candidates" — review pending memory candidates in an
            // interactive overlay (a approve · r reject · s scope). Core owns
            // the candidate store; this only lists the pending ones.
            const pending = pendingCandidates(listMemoryCandidates(projectPath));
            if (pending.length === 0) {
              notice("no pending memory candidates — nothing to review");
              break;
            }
            dispatch({
              type: "overlay",
              overlay: { kind: "candidates", candidates: pending, index: 0, scope: "project" },
            });
            break;
          }
          if (command.arg?.startsWith("edit")) {
            // "/memory edit [file]" — files restricted to .seekforge/memory/.
            const fileArg = command.arg.slice(4).trim();
            const memoryDir = dirname(projectMemoryPath(projectPath));
            const target = resolveMemoryEditTarget(memoryDir, projectMemoryPath(projectPath), fileArg);
            if (target === null) {
              notice("memory files live under .seekforge/memory/ only", "error");
              break;
            }
            setRawMode(false);
            const r = spawnSync(process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi", [target], {
              stdio: "inherit",
            });
            setRawMode(true);
            if (r.error) notice(`editor failed: ${r.error.message}`, "error");
            else notice("memory file saved");
            break;
          }
          const facts = listProjectFacts(projectPath);
          if (facts.length === 0) {
            notice("project memory is empty — /remember <fact> or # <fact> adds one");
            break;
          }
          notice(`project memory (${facts.length} facts):`);
          for (const f of facts.slice(0, 30)) notice(`  ${f.index}. ${f.line}`);
          if (facts.length > 30) notice(`  … ${facts.length - 30} more (/memory edit opens the file)`);
          break;
        }
        case "review":
          if (controllerRef.current) {
            notice("a task is already running — wait for it to finish", "error");
            break;
          }
          dispatch({ type: "user", text: "/review — review the uncommitted changes" });
          void runTask(
            "Review the uncommitted changes in this repository. Use git_diff (and read_file for context) to inspect them. " +
              "Report findings grouped by severity (bugs, risks, style), each with file:line references. " +
              "Do NOT modify any files — this is a read-only review.",
            { mode: "ask", echoUser: false },
          );
          break;
        case "tab": {
          const arg = command.arg;
          if (!arg || arg === "new") {
            tabsDispatch({ type: "tab-new", model: modelRef.current });
          } else if (arg === "close") {
            const closing = activeIdRef.current;
            const entry = runsByTabRef.current.get(closing);
            if (entry) {
              notice("this tab has a running task — Esc cancels it or Ctrl+B detaches it first", "error");
              break;
            }
            runsByTabRef.current.delete(closing);
            tabsDispatch({ type: "tab-close" });
          } else if (arg === "next") {
            tabsDispatch({ type: "tab-next" });
          } else if (/^[1-9][0-9]*$/.test(arg)) {
            tabsDispatch({ type: "tab-switch", index: Number(arg) - 1 });
          } else {
            notice("usage: /tab [new|close|next|<n>]", "error");
          }
          break;
        }
        case "fork": {
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            notice("no active session to fork", "error");
            break;
          }
          const forked = forkSession(projectPath, sessionId);
          if (!forked) {
            notice("fork failed — session not found on disk", "error");
            break;
          }
          dispatch({ type: "set-session", sessionId: forked });
          notice(`forked → ${forked} — next message continues the fork; the original is untouched`);
          break;
        }
        case "todo": {
          const arg = command.arg ?? "";
          const [verb, ...restWords] = arg.split(/\s+/).filter(Boolean);
          try {
            if (!verb) {
              for (const line of formatTodoLines(loadTodos(projectPath))) notice(line);
            } else if (verb === "add" && restWords.length > 0) {
              const t = addTodo(projectPath, restWords.join(" "));
              notice(`added todo ${t.index}: ${t.text}`);
            } else if (verb === "done" && restWords[0]) {
              const t = toggleTodo(projectPath, Number(restWords[0]));
              notice(t ? `${t.done ? "done" : "reopened"}: ${t.text}` : "no such todo", t ? "dim" : "error");
            } else if (verb === "rm" && restWords[0]) {
              const t = removeTodo(projectPath, Number(restWords[0]));
              notice(t ? `removed: ${t.text}` : "no such todo", t ? "dim" : "error");
            } else {
              notice("usage: /todo [add <text> | done <n> | rm <n>]", "error");
            }
          } catch (err) {
            notice(`todo error: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          break;
        }
        case "add-dir": {
          if (!command.arg) {
            for (const line of formatExtraDirLines(extraDirsRef.current)) notice(line);
            break;
          }
          const dir = normalizeExtraDir(command.arg, projectPath);
          if (!dir) {
            notice("not a directory (or inside the workspace already)", "error");
            break;
          }
          if (!extraDirsRef.current.includes(dir)) extraDirsRef.current.push(dir);
          notice(`added read-only dir: ${dir} — reference its files with @${dir}/…`);
          break;
        }
        case "terminal-setup":
          for (const line of terminalSetupInstructions(detectTerminal())) notice(line);
          break;
        case "think": {
          const cfg = runConfigRef.current;
          const arg = command.arg;
          if (!arg) {
            notice(
              `thinking: ${cfg.thinking === false ? "off" : "on"}${cfg.reasoningEffort ? ` · effort ${cfg.reasoningEffort}` : ""} (V4 models only — /think on|off|high|max)`,
            );
            break;
          }
          if (arg === "on") cfg.thinking = true;
          else if (arg === "off") cfg.thinking = false;
          else if (arg === "high" || arg === "max") {
            cfg.thinking = true;
            cfg.reasoningEffort = arg;
          } else {
            notice("usage: /think [on|off|high|max]", "error");
            break;
          }
          notice(
            `thinking ${cfg.thinking === false ? "off" : "on"}${cfg.reasoningEffort ? ` · effort ${cfg.reasoningEffort}` : ""} — applies from the next message` +
              (modelRef.current.startsWith("deepseek-v4") ? "" : " (needs a deepseek-v4 model: /model)"),
          );
          break;
        }
        case "diff": {
          const r = spawnSync("git", ["diff"], { cwd: projectPath, encoding: "utf8", maxBuffer: 4_000_000 });
          if (r.status !== 0 && r.stderr) {
            notice(`git diff failed: ${r.stderr.trim().slice(0, 200)}`, "error");
            break;
          }
          const text = (r.stdout ?? "").trim();
          if (text === "") {
            notice("working tree clean — no uncommitted changes");
            break;
          }
          dispatch({ type: "diff", path: "working tree (git diff)", lines: classifyUnifiedDiff(text) });
          break;
        }
        case "worktree": {
          const sub = parseWorktreeCommand(command.arg);
          if (sub.kind === "usage") {
            notice("usage: /worktree [list | new [name] | remove <slug-or-branch>]");
            notice("  list                 show SeekForge worktree sessions");
            notice("  new [name]           create an isolated checkout on a new branch");
            notice("  remove <slug|branch> delete a worktree session");
            break;
          }
          if (sub.kind === "list") {
            void (async () => {
              try {
                const entries = seekforgeWorktrees(await listGitWorktrees(projectPath));
                if (entries.length === 0) {
                  notice("no SeekForge worktree sessions — create one with /worktree new [name]");
                  return;
                }
                notice(`SeekForge worktree sessions (${entries.length}):`);
                for (const e of entries) {
                  const dirty = await isWorktreeDirty(e.path).catch(() => false);
                  notice(`  ${e.branch}${dirty ? "  (dirty)" : ""}`);
                  notice(`    ${e.path}`, "dim");
                }
              } catch (err) {
                notice(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
              }
            })();
            break;
          }
          if (sub.kind === "new") {
            const name = sub.name;
            void (async () => {
              try {
                const slug = await pickFreeSlug(name, (s) => worktreeBranchExists(projectPath, s));
                const { path, branch } = await createWorktree(projectPath, slug);
                notice(`created worktree on ${branch}`);
                notice(`  ${path}`, "dim");
                notice(`  isolated checkout — open in a new terminal: cd ${path} && seekforge`, "dim");
              } catch (err) {
                if (err instanceof WorktreeGitError && err.code === "not_a_git_repo") {
                  notice("not a git repository — /worktree needs a git repo", "error");
                } else {
                  notice(`worktree new failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                }
              }
            })();
            break;
          }
          // sub.kind === "remove"
          if (!sub.target) {
            notice("usage: /worktree remove <slug-or-branch>", "error");
            break;
          }
          const target = sub.target;
          void (async () => {
            try {
              const entries = await listGitWorktrees(projectPath);
              const entry = resolveWorktreeTarget(entries, target);
              if (!entry) {
                const managed = seekforgeWorktrees(entries);
                if (managed.length === 0) {
                  notice(`no SeekForge worktree matches "${target}" — there are none`, "error");
                } else {
                  notice(`no SeekForge worktree matches "${target}". available:`, "error");
                  for (const e of managed) notice(`  ${e.branch}`);
                }
                return;
              }
              await removeWorktree(projectPath, entry.path, entry.branch);
              notice(`removed worktree ${entry.branch}`);
            } catch (err) {
              notice(`worktree remove failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          })();
          break;
        }
        case "export": {
          const rel = command.arg ?? defaultExportPath();
          const target = isAbsolute(rel) ? rel : resolve(projectPath, rel);
          try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, transcriptToMarkdown(stateRef.current.items, { title: `SeekForge session ${stateRef.current.sessionId ?? ""}` }));
            notice(`exported transcript → ${rel}`);
          } catch (err) {
            notice(`export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          break;
        }
        case "audit": {
          const sessionId = command.arg ?? sessionIdRef.current;
          if (!sessionId) {
            notice("no active session to audit", "error");
            break;
          }
          const audit = buildSessionAudit(projectPath, sessionId);
          if (!audit) {
            notice(`no trace for session ${sessionId}`, "error");
            break;
          }
          const rel = auditExportPath(sessionId);
          const target = resolve(projectPath, rel);
          try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, renderSessionAuditMarkdown(audit));
            notice(`wrote audit → ${rel}`);
          } catch (err) {
            notice(`audit failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          break;
        }
        case "agents":
          for (const line of formatAgentLines(loadAgentDefinitions(projectPath))) notice(line);
          break;
        case "skills":
          for (const line of formatSkillLines(loadSkillsWithStatus(projectPath))) notice(line);
          break;
        case "init":
          if (controllerRef.current) {
            notice("a task is already running — wait for it to finish", "error");
            break;
          }
          dispatch({ type: "user", text: "/init — analyze the codebase and write AGENTS.md" });
          void runTask(INIT_PROMPT, { echoUser: false });
          break;
        case "doctor": {
          notice("doctor:");
          const doctorChecks = runDoctor(projectPath, config, createDefaultProbes());
          doctorChecks.push(configParseCheck(configParseErrors(projectPath)));
          doctorChecks.push(configKeysCheck(unknownConfigKeys(projectPath)));
          for (const line of formatDoctorLines(doctorChecks)) {
            notice(`  ${line}`);
          }
          break;
        }
        case "mouse":
          setMouseOn((on) => {
            notice(
              on
                ? "mouse capture off — select text normally; PageUp/PageDown scrolls"
                : "mouse wheel scroll on — hold Shift (Option on iTerm2) to select text",
            );
            return !on;
          });
          break;
        case "vim":
          setVimOn((on) => {
            notice(on ? "vim mode off" : "vim mode on — Esc for NORMAL, i to insert");
            return !on;
          });
          setVim(initialVim());
          break;
        case "backtrack": {
          const targets = backtrackTargets(stateRef.current.items);
          if (targets.length === 0) {
            notice("nothing to backtrack — need at least a second message in this session");
            break;
          }
          if (controllerRef.current) {
            notice("cannot backtrack while a task runs — Esc cancels it first", "error");
            break;
          }
          dispatch({ type: "overlay", overlay: { kind: "backtrack", targets, index: targets.length - 1 } });
          break;
        }
        case "mcp":
          for (const line of formatMcpLines(config.mcpServers, mcpToolSpecs)) notice(line);
          if (mcpEntries.length > 0) {
            notice("(connections are per-process — restart the TUI to reconnect; edit config.json to add/remove servers)");
            void listMcpResources(mcpEntries)
              .then((rs) => {
                if (rs.length === 0) return;
                notice(`resources (${rs.length}) — reference with @mcp:<server>:<uri> in a message:`);
                for (const r of rs.slice(0, 10)) notice(`  @mcp:${r.server}:${r.uri}${r.name ? `  (${r.name})` : ""}`);
                if (rs.length > 10) notice(`  … ${rs.length - 10} more`);
              })
              .catch(() => {});
          }
          break;
        case "prompts": {
          // /mcp:<server>:<prompt> commands surface here; arguments are passed
          // best-effort (see mcp-prompt-commands.ts).
          for (const line of formatMcpPromptLines(mcpPromptsRef.current)) notice(line);
          if (mcpPromptsRef.current.length > 0) {
            notice("invoke with /mcp:<server>:<prompt> [args] (args bind to the prompt's first declared argument)");
          }
          break;
        }
        case "context":
          dispatch({ type: "overlay", overlay: { kind: "context" } });
          break;
        case "compact": {
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            notice("no active session — compaction also runs automatically past the budget");
            break;
          }
          if (controllerRef.current) {
            notice("wait for the running task to finish before compacting", "error");
            break;
          }
          // With a focus argument the middle is summarized by the model
          // (steered by the focus); without one it stays the instant
          // deterministic digest.
          if (command.arg) {
            const focus = command.arg;
            notice(`compacting with focus: ${focus} …`);
            void (async () => {
              try {
                // Build a provider via the same path the factory uses, then let
                // CORE's llmCompactSessionNow load → summarize (focus-steered) →
                // rewrite the session messages in one canonical call.
                const provider = createDeepSeekProvider({
                  apiKey: runConfigRef.current.apiKey ?? "",
                  baseUrl: runConfigRef.current.baseUrl,
                  model: modelRef.current,
                });
                const result = await llmCompactSessionNow(projectPath, sessionId, provider, focus);
                if (!result) {
                  notice("nothing to compact — the session is still short (or the model call failed)");
                  return;
                }
                notice(
                  `compacted (LLM, focused): dropped ${result.droppedTurns} earlier messages, ` +
                    `${kfmt(result.beforeTokens)} → ${kfmt(result.afterTokens)} tokens`,
                );
              } catch (err) {
                notice(`compact failed: ${err instanceof Error ? err.message : String(err)}`, "error");
              }
            })();
            break;
          }
          const result = compactSessionNow(projectPath, sessionId);
          if (!result) {
            notice("nothing to compact — the session is still short");
            break;
          }
          notice(
            `compacted: dropped ${result.droppedTurns} earlier messages, ` +
              `${kfmt(result.beforeTokens)} → ${kfmt(result.afterTokens)} tokens (applies on the next message)`,
          );
          break;
        }
        case "usage": {
          const turns = stateRef.current.items.filter((i) => i.kind === "user").length;
          for (const line of formatUsageDetail(stateRef.current.totalUsage, {
            durationMs: Date.now() - appStartRef.current,
            turns,
          }))
            notice(line);
          break;
        }
        case "copy": {
          const lastAssistant = [...stateRef.current.items].reverse().find((i) => i.kind === "assistant");
          if (!lastAssistant || lastAssistant.kind !== "assistant") {
            notice("nothing to copy yet");
          } else if (copyToClipboard(lastAssistant.text)) {
            notice(`copied last reply (${kfmt(lastAssistant.text.length)} chars)`);
          } else {
            notice("no clipboard tool found (pbcopy/xclip/wl-copy)", "error");
          }
          break;
        }
        case "editor":
          openExternalEditor();
          break;
        case "status": {
          const live = (bgRef.current?.list() ?? []).filter((t) => t.status === "running").length;
          const cfg = runConfigRef.current;
          const s = stateRef.current;
          for (const line of formatStatusLines({
            ...(versionRef.current ? { version: versionRef.current } : {}),
            model: modelRef.current,
            projectPath,
            ...(s.sessionId ? { sessionId: s.sessionId } : {}),
            approval: s.approval,
            vim: vimOn,
            ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
            ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
            ...(cfg.sandbox ? { sandbox: cfg.sandbox } : {}),
            keySource: process.env["DEEPSEEK_API_KEY"] ? "env" : cfg.apiKey ? "config" : "none",
            uptimeMs: Date.now() - appStartRef.current,
            costUsd: s.totalUsage.costUsd,
            totalTokens: s.totalUsage.promptTokens + s.totalUsage.completionTokens,
            ...(s.context ? { contextPercent: s.context.percent } : {}),
            mcpServers: Object.keys(config.mcpServers ?? {}).length,
            extraDirs: extraDirsRef.current.length,
            bgRunning: live,
            detachedRuns: s.detached.length,
          }))
            notice(line);
          break;
        }
        case "config": {
          if (command.arg === "edit") {
            setRawMode(false);
            const r = spawnSync(process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi", [join(homedir(), ".seekforge", "config.json")], {
              stdio: "inherit",
            });
            setRawMode(true);
            notice(r.error ? `editor failed: ${r.error.message}` : "config saved — restart the TUI to apply", r.error ? "error" : "dim");
            break;
          }
          for (const line of formatConfigLines(config, {
            global: join(homedir(), ".seekforge", "config.json"),
            project: join(projectPath, ".seekforge", "config.json"),
          }))
            notice(line);
          break;
        }
        case "permissions":
          for (const line of formatPermissionLines({
            rules: config.permissionRules ?? [],
            builtinAllowlist: BUILTIN_COMMAND_ALLOWLIST,
            configAllowlist: config.commandAllowlist ?? [],
            sessionAllowlist: allowlistRef.current.filter((p) => !(config.commandAllowlist ?? []).includes(p)),
            ...(runConfigRef.current.sandbox ? { sandbox: runConfigRef.current.sandbox } : {}),
            approval: stateRef.current.approval,
          }))
            notice(line);
          break;
        case "hooks":
          for (const line of formatHookLines(config.hooks)) notice(line);
          break;
        case "release-notes":
          for (const line of formatReleaseNotes(findChangelogSection([projectPath]), versionRef.current)) notice(line);
          break;
        case "bug": {
          const bugDoctorChecks = runDoctor(projectPath, config, createDefaultProbes());
          bugDoctorChecks.push(configParseCheck(configParseErrors(projectPath)));
          bugDoctorChecks.push(configKeysCheck(unknownConfigKeys(projectPath)));
          const report = buildBugReport({
            ...(versionRef.current ? { version: versionRef.current } : {}),
            platform: process.platform,
            nodeVersion: process.version,
            model: modelRef.current,
            doctorLines: formatDoctorLines(bugDoctorChecks),
            ...(lastErrorRef.current ? { lastError: lastErrorRef.current } : {}),
          });
          const copied = copyToClipboard(report);
          notice(copied ? "bug report copied to the clipboard — paste it into a GitHub issue:" : "clipboard unavailable — report follows:", "dim");
          notice("  https://github.com/eilyeee/seekforge/issues/new");
          if (!copied) for (const l of report.split("\n").slice(0, 30)) notice(`  ${l}`);
          break;
        }
        case "theme": {
          if (!command.arg) {
            dispatch({
              type: "overlay",
              overlay: {
                kind: "theme",
                ids: Object.keys(THEME_PRESETS),
                lines: themePickerLines(config.accent ?? "default"),
                index: 0,
              },
            });
            notice("themes — Enter applies for this session; set \"accent\" in config.json to persist");
            break;
          }
          setAccent(loadTheme(command.arg).accent);
          notice(`theme: ${command.arg} (session only — set "accent" in config.json to persist)`);
          break;
        }
        case "balance":
          void fetchBalance(runConfigRef.current.apiKey ?? "", runConfigRef.current.baseUrl).then((b) =>
            notice(b ? `balance: ${b.totalBalance} ${b.currency}` : "balance unavailable (network or auth)", b ? "dim" : "error"),
          );
          break;
        case "stash": {
          if (command.arg === "pop") {
            const draft = stashPop(projectPath);
            if (draft === null) notice("stash is empty");
            else applyEditor(setText(draft));
            break;
          }
          if (command.arg === "list") {
            const drafts = stashList(projectPath);
            if (drafts.length === 0) notice("stash is empty");
            for (const [i, d] of drafts.entries()) notice(`  ${i + 1}. ${d.replace(/\s+/g, " ").slice(0, 60)}`);
            break;
          }
          if (editor.text.trim() === "") {
            notice("nothing to stash — type a draft first (/stash pop restores)");
            break;
          }
          const count = stashPush(projectPath, editor.text);
          applyEditor(emptyEditor());
          notice(`stashed draft (${count} in stash) — /stash pop restores`);
          break;
        }
        case "handoff": {
          if (command.arg === "list") {
            const all = listHandoffs(projectPath);
            if (all.length === 0) notice("no handoffs yet — /handoff writes one");
            for (const h of all.slice(0, 10)) notice(`  ${h}`);
            break;
          }
          const rel = handoffPath();
          const target = resolve(projectPath, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            buildHandoff({
              items: stateRef.current.items,
              ...(stateRef.current.sessionId ? { sessionId: stateRef.current.sessionId } : {}),
              model: modelRef.current,
              costUsd: stateRef.current.totalUsage.costUsd,
            }),
          );
          notice(`handoff written → ${rel} (next session: read it or /handoff list)`);
          break;
        }
        case "quit":
          quit();
          break;
        case "unknown": {
          // User-defined commands (.seekforge/commands/*.md) resolve here.
          const [head, ...rest] = command.raw.slice(1).split(/\s+/);
          const custom = (customCommandsRef.current ?? []).find((c) => c.name === (head ?? "").toLowerCase());
          if (custom) {
            if (controllerRef.current) {
              notice("a task is already running — wait for it to finish", "error");
              break;
            }
            dispatch({ type: "user", text: command.raw });
            void runTask(expandCustomCommand(custom, rest.join(" ").trim()), { echoUser: false });
            break;
          }
          // Skills are invocable as /skill:<id> [task].
          const skill = findSkillByCommand(
            attachSkillContent(projectPath, skillRowsRef.current ?? []),
            (head ?? "").toLowerCase(),
          );
          if (skill) {
            if (controllerRef.current) {
              notice("a task is already running — wait for it to finish", "error");
              break;
            }
            dispatch({ type: "user", text: command.raw });
            void runTask(expandSkillCommand(skill, rest.join(" ").trim()), { echoUser: false });
            break;
          }
          // MCP prompts are invocable as /mcp:<server>:<prompt> [args].
          const prompt = findPromptByCommand(mcpPromptsRef.current, (head ?? "").toLowerCase());
          if (prompt) {
            if (controllerRef.current) {
              notice("a task is already running — wait for it to finish", "error");
              break;
            }
            const argText = rest.join(" ").trim();
            dispatch({ type: "user", text: command.raw });
            void (async () => {
              let task: string;
              try {
                task = await getMcpPrompt(
                  prompt.server,
                  prompt.name,
                  promptArgsFromText(prompt, argText),
                  mcpEntries,
                );
              } catch (err) {
                notice(`mcp prompt ${prompt.server}:${prompt.name} failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                return;
              }
              void runTask(task, { echoUser: false });
            })();
            break;
          }
          const suggestion = didYouMean(head ?? "", [
            ...COMMANDS,
            ...customCommandSpecs(customCommandsRef.current ?? []),
            ...skillCommandSpecs(skillRowsRef.current ?? []),
            ...mcpPromptCommandSpecs(mcpPromptsRef.current),
          ]);
          notice(
            `unknown command ${command.raw}${suggestion ? ` — did you mean /${suggestion}?` : ""} (/help lists all)`,
            "error",
          );
          break;
        }
      }
    },
    [notice, projectPath, config.mcpServers, mcpToolSpecs, mcpEntries, runTask, runLoopTask, resumeLoopTask, openExternalEditor, quit, syncBg, setRawMode],
  );

  // ---------------------------------------------------------------------
  // Submit.
  // ---------------------------------------------------------------------

  /** "!cmd" passthrough: the user's own shell command, run locally, blocking. */
  const runBash = useCallback(
    (command: string) => {
      const r = spawnSync("/bin/sh", ["-c", command], {
        cwd: projectPath,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4_000_000,
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd() || (r.error ? String(r.error.message) : "(no output)");
      dispatch({ type: "shell", command, output, exitCode: r.status ?? 1 });
    },
    [projectPath],
  );

  const handleSubmit = useCallback(() => {
    const raw = expandPastes(pasteRegistryRef.current, editor.text);
    const parsed = parseInput(raw);
    applyEditor(emptyEditor());
    if (parsed.kind === "empty") return;
    appendHistory(historyFile, raw);
    historyEntriesRef.current = loadHistory(historyFile);
    historyNavRef.current = createHistoryNav(historyEntriesRef.current);
    if (parsed.kind === "slash") {
      handleSlash(parsed.command);
      return;
    }
    if (parsed.kind === "bash") {
      runBash(parsed.command);
      return;
    }
    // Steering: typing during a run queues the message; it is sent (in
    // order) as soon as the current turn ends.
    if (stateRef.current.running) {
      dispatch({ type: "queue", text: parsed.text });
      return;
    }
    submitTask(parsed.text);
  }, [editor.text, applyEditor, historyFile, handleSlash, runBash, submitTask]);

  // Drain the steering queue between runs.
  useEffect(() => {
    if (state.running || state.planPending || state.permission || state.queue.length === 0) return;
    const next = state.queue[0];
    if (next === undefined) return;
    dispatch({ type: "dequeue" });
    submitTask(next);
  }, [state.running, state.planPending, state.permission, state.queue, submitTask]);

  // ---------------------------------------------------------------------
  // Key routing: permission → plan decision → Ctrl+C → overlay → global →
  // composer. One useInput so ordering is explicit (DESIGN.md).
  // ---------------------------------------------------------------------

  const acceptPaletteEntry = useCallback(
    (run: boolean) => {
      const overlay = stateRef.current.overlay;
      if (overlay?.kind !== "palette") return;
      const spec = paletteCommands[overlay.index];
      if (!spec) {
        dispatch({ type: "overlay", overlay: null });
        return;
      }
      if (run && !spec.args) {
        applyEditor(emptyEditor());
        const custom = (customCommandsRef.current ?? []).find((c) => c.name === spec.name);
        if (custom) {
          // Guard like every other runTask entry point: starting a second run
          // here would overwrite the active controller in runsByTabRef, orphaning
          // the first run so Esc/Ctrl+C can no longer abort it.
          if (controllerRef.current) {
            notice("a task is already running — Esc cancels it, or wait for it to finish", "error");
            return;
          }
          dispatch({ type: "user", text: `/${spec.name}` });
          void runTask(expandCustomCommand(custom, ""), { echoUser: false });
          return;
        }
        // MCP prompt commands (and other dynamic names) aren't built-in
        // SlashCommands; route them through the unknown-command resolver.
        if (findPromptByCommand(mcpPromptsRef.current, spec.name)) {
          handleSlash({ name: "unknown", raw: `/${spec.name}` });
          return;
        }
        handleSlash({ name: spec.name } as SlashCommand);
        return;
      }
      applyEditor(setText(`/${spec.name} `));
    },
    [paletteCommands, applyEditor, handleSlash],
  );

  const acceptFileEntry = useCallback(() => {
    const overlay = stateRef.current.overlay;
    if (overlay?.kind !== "files") return;
    const file = pickerFiles[overlay.index];
    if (!file) {
      dispatch({ type: "overlay", overlay: null });
      return;
    }
    bumpFrecency(projectPath, file);
    applyEditor(replaceAtToken(editor, overlay.anchor, file));
  }, [pickerFiles, projectPath, editor, applyEditor]);

  /** Backtrack: truncate the stored conversation (and optionally files). */
  const applyBacktrack = useCallback(
    (target: { turn: number; text: string; itemIndex: number }, withFiles: boolean) => {
      const sessionId = sessionIdRef.current;
      const result = sessionId ? truncateSessionAtUserTurn(projectPath, sessionId, target.turn) : null;
      if (!result) {
        notice("backtrack failed — the stored session no longer matches this transcript", "error");
        return;
      }
      dispatch({ type: "backtrack-apply", itemIndex: target.itemIndex });
      applyEditor(setText(target.text));
      let fileNote = "file changes kept";
      if (withFiles && sessionId) {
        const fr = rewindSessionToTurn(projectPath, sessionId, target.turn);
        const restored = fr.restored.length + fr.deleted.length;
        fileNote =
          restored > 0
            ? `${fr.restored.length} files restored, ${fr.deleted.length} deleted`
            : "no file changes to revert";
        for (const s of fr.skipped.slice(0, 5)) notice(`  skipped ${s.path}: ${s.reason}`, "error");
      }
      notice(`rewound to turn ${target.turn} (${result.removedMessages} messages dropped; ${fileNote})`);
    },
    [projectPath, notice, applyEditor],
  );

  const cycleApproval = useCallback(() => {
    const next = nextApproval(approvalRef.current);
    dispatch({ type: "set-approval", approval: next });
    notice(`approval mode: ${next}`);
  }, [notice]);

  const handleCtrlC = useCallback(() => {
    if (controllerRef.current) {
      sigintCountRef.current += 1;
      controllerRef.current.abort();
      if (sigintCountRef.current >= 2) {
        quit();
        return;
      }
      notice("cancelling… (Ctrl+C again to force-exit)");
    } else {
      quit();
    }
  }, [quit, notice]);

  useInput((rawInput, key) => {
    const stroke: KeyStroke = toStroke(rawInput, key as unknown as InkKey);

    // 0. Mouse events (SGR sequences arrive as raw input chunks, with the
    // leading ESC already consumed by Ink). Wheel scrolls; everything else
    // (clicks, releases, drags) is swallowed so it never lands in the
    // composer as literal "[<65;60;39M" text.
    if (isMouseEvent(rawInput)) {
      const wheel = parseMouseWheel(rawInput);
      if (wheel) {
        dispatch({
          type: "scroll",
          delta: wheel === "up" ? 3 : -3,
          max: Math.max(0, stateRef.current.items.length - VIEW_ITEMS),
        });
      }
      return;
    }

    // 0.5 Pager (Ctrl+L): modal full-transcript scroller.
    if (pager) {
      const h = 20;
      // The last useful offset is length - h (the window clamps start there);
      // going past it just shows the same final page and wastes keystrokes.
      const maxOffset = Math.max(0, pager.lines.length - h);
      if (stroke.name === "escape" || rawInput === "q") setPager(null);
      else if (stroke.name === "up") setPager({ ...pager, offset: Math.max(0, pager.offset - 1) });
      else if (stroke.name === "down") setPager({ ...pager, offset: Math.min(maxOffset, pager.offset + 1) });
      else if (stroke.name === "pageup") setPager({ ...pager, offset: Math.max(0, pager.offset - h) });
      else if (stroke.name === "pagedown") setPager({ ...pager, offset: Math.min(maxOffset, pager.offset + h) });
      else if (rawInput === "g") setPager({ ...pager, offset: 0 });
      else if (rawInput === "G") setPager({ ...pager, offset: maxOffset });
      return;
    }

    // 0.6 Sidebar focus (Ctrl+E): tree navigation until closed/unfocused.
    if (sidebar?.focused) {
      const visible = visibleNodes(sidebar.nodes, sidebar.expanded);
      if (stroke.name === "escape" || (stroke.ctrl && stroke.input === "e")) {
        setSidebar(null);
        return;
      }
      if (stroke.name === "up" || stroke.name === "down") {
        setSidebar({ ...moveCursor(sidebar, stroke.name === "up" ? -1 : 1), focused: true });
        return;
      }
      const node = visible[sidebar.cursor];
      if ((stroke.name === "left" || stroke.name === "right") && node?.dir) {
        setSidebar({ ...toggleDir(sidebar, node.path), focused: true });
        return;
      }
      if (stroke.name === "return" && node) {
        if (node.dir) {
          setSidebar({ ...toggleDir(sidebar, node.path), focused: true });
        } else {
          applyEditor(insertText(editor, `@${node.path} `));
          setSidebar({ ...sidebar, focused: false });
        }
        return;
      }
      return; // modal while focused
    }

    // 1. Permission prompt: y allow once / a allow for session / anything else deny.
    //    "a" returns the richer { allow, remember: "session" } so CORE grows
    //    its canonical sessionAllowlist (the local allowlistRef is also kept in
    //    sync for /permissions display and command-prefix matching).
    //    Multi-hunk mode (hunks.length > 1): digit keys toggle individual
    //    hunks, "a" selects all, "y" confirms the current selection, "n" denies.
    if (pendingPermissionRef.current) {
      const pending = pendingPermissionRef.current;
      const hunks = pending.request.hunks;

      // Multi-hunk mode: interactive hunk selection.
      if (hunks && hunks.length > 1) {
        const numHunks = hunks.length;
        // Digit key (1-9) toggles the corresponding hunk.
        if (/^[1-9]$/.test(rawInput)) {
          const idx = Number(rawInput) - 1;
          if (idx < numHunks) {
            setHunkSelection((prev) =>
              prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort(),
            );
          }
          return;
        }
        // "a" selects all hunks.
        if (rawInput.toLowerCase() === "a") {
          setHunkSelection(hunks.map((h) => h.index));
          return;
        }
        // "y" confirms with current selection.
        if (rawInput.toLowerCase() === "y") {
          const selected = hunkSelection;
          if (selected.length === numHunks) {
            // All hunks selected: resolve as simple allow.
            pendingPermissionByTabRef.current.delete(activeIdRef.current);
            dispatch({ type: "permission-resolved" });
            pending.resolve(true);
          } else if (selected.length > 0) {
            // Subset selected: resolve with selectedHunks.
            pendingPermissionByTabRef.current.delete(activeIdRef.current);
            dispatch({ type: "permission-resolved" });
            pending.resolve({ allow: true, selectedHunks: selected });
          } else {
            // No hunks selected: treat as deny.
            pendingPermissionByTabRef.current.delete(activeIdRef.current);
            dispatch({ type: "permission-resolved" });
            pending.resolve(false);
          }
          return;
        }
        // Any other key denies.
        pendingPermissionByTabRef.current.delete(activeIdRef.current);
        dispatch({ type: "permission-resolved" });
        pending.resolve(false);
        return;
      }

      // Single-hunk / no-hunk: original behavior unchanged.
      const result: ConfirmResult = permissionResultForKey(rawInput);
      // "a" (allow for session) also mirrors the command prefix into the local
      // allowlist for /permissions display and command-prefix matching; CORE's
      // canonical sessionAllowlist grows from the remember:"session" result.
      if (typeof result === "object" && result.remember === "session" && pending.request.command) {
        const prefix = sessionAllowPrefix(pending.request.command);
        if (prefix && !allowlistRef.current.includes(prefix)) {
          allowlistRef.current.push(prefix);
          notice(`allowed for this session: ${prefix} …`);
        }
      }
      pendingPermissionByTabRef.current.delete(activeIdRef.current);
      dispatch({ type: "permission-resolved" });
      pending.resolve(result);
      return;
    }

    // 2. Pending plan decision (after a /plan run finished).
    if (stateRef.current.planPending && !stateRef.current.running) {
      dispatch({ type: "plan-pending", pending: false });
      if (rawInput.toLowerCase() === "y") {
        void runTask(EXECUTE_PLAN_PROMPT, { mode: "edit", echoUser: false });
      } else {
        notice("plan kept; the session continues — refine it or /new");
      }
      return;
    }

    // 3. Ctrl+C everywhere.
    if (stroke.ctrl && stroke.input === "c") {
      handleCtrlC();
      return;
    }

    // 3.5 Reverse history search captures everything while open.
    if (search) {
      if (stroke.ctrl && stroke.input === "r") {
        setSearch(searchNext(search));
      } else if (stroke.name === "escape") {
        setSearch(null);
      } else if (stroke.name === "return") {
        const match = currentMatch(search, searchEntriesRef.current);
        setSearch(null);
        if (match !== null) applyEditor(setText(match));
      } else if (stroke.name === "backspace" || stroke.name === "delete") {
        setSearch(searchBackspace(search, searchEntriesRef.current));
      } else if (rawInput.length > 0 && !key.ctrl && !key.meta) {
        setSearch(searchInput(search, searchEntriesRef.current, rawInput));
      }
      return;
    }

    // 4. Overlay scope (palette / file picker / context inspector / pickers).
    const overlay = stateRef.current.overlay;
    if (overlay) {
      if (overlay.kind === "context") {
        if (stroke.name === "escape" || stroke.name === "return" || rawInput === "q") {
          dispatch({ type: "overlay", overlay: null });
        }
        return;
      }
      // Help overlay: navigate command rows, Enter inserts the command.
      if (overlay.kind === "help") {
        if (stroke.name === "escape" || rawInput === "q") {
          dispatch({ type: "overlay", overlay: null });
        } else if (stroke.name === "up" || stroke.name === "down") {
          dispatch({ type: "overlay-move", delta: stroke.name === "up" ? -1 : 1, count: overlay.selectable.length });
        } else if (stroke.name === "return" || stroke.name === "tab") {
          const name = overlay.names[overlay.index];
          dispatch({ type: "overlay", overlay: null });
          if (name) applyEditor(setText(`/${name} `));
        }
        return;
      }
      // ask_user question: modal; digits jump, Enter answers, Esc declines.
      if (overlay.kind === "question") {
        const resolveAnswer = (answer: string): void => {
          const resolve = pendingQuestionRef.current;
          pendingQuestionByTabRef.current.delete(activeIdRef.current);
          dispatch({ type: "overlay", overlay: null });
          resolve?.(answer);
        };
        if (stroke.name === "escape") {
          resolveAnswer("(the user declined to answer)");
        } else if (stroke.name === "return") {
          resolveAnswer(overlay.options[overlay.index] ?? "(the user declined to answer)");
        } else if (stroke.name === "up" || stroke.name === "down") {
          dispatch({ type: "overlay-move", delta: stroke.name === "up" ? -1 : 1, count: overlay.options.length });
        } else if (/^[1-9]$/.test(rawInput)) {
          const n = Number(rawInput) - 1;
          if (n < overlay.options.length) {
            const picked = overlay.options[n];
            if (picked !== undefined) resolveAnswer(picked);
          }
        }
        return;
      }
      // Sessions: "f" forks the selected session instead of resuming it.
      if (overlay.kind === "sessions" && rawInput.toLowerCase() === "f" && !stroke.ctrl) {
        const id = overlay.ids[overlay.index];
        dispatch({ type: "overlay", overlay: null });
        if (id) {
          const forked = forkSession(projectPath, id);
          if (forked) {
            dispatch({ type: "set-session", sessionId: forked });
            notice(`forked ${id.slice(0, 12)}… → ${forked} — next message continues the fork`);
          } else {
            notice("fork failed — session not found on disk", "error");
          }
        }
        return;
      }
      // Backtrack: "c" rewinds the conversation only (Enter = conversation + files).
      if (overlay.kind === "backtrack" && rawInput.toLowerCase() === "c" && !stroke.ctrl) {
        const target = overlay.targets[overlay.index];
        dispatch({ type: "overlay", overlay: null });
        if (target) applyBacktrack(target, false);
        return;
      }
      // Memory candidates: a approves, r rejects, s toggles the approve scope.
      if (overlay.kind === "candidates") {
        const key = rawInput.toLowerCase();
        if (key === "s" && !stroke.ctrl) {
          const scope = overlay.scope === "project" ? "user" : "project";
          dispatch({ type: "overlay", overlay: { ...overlay, scope } });
          return;
        }
        if ((key === "a" || key === "r") && !stroke.ctrl) {
          const candidate = overlay.candidates[overlay.index];
          if (!candidate) {
            dispatch({ type: "overlay", overlay: null });
            return;
          }
          try {
            if (key === "a") approveMemoryCandidate(projectPath, candidate.id, overlay.scope);
            else rejectMemoryCandidate(projectPath, candidate.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            notice(`memory ${key === "a" ? "approve" : "reject"} failed: ${message}`, "error");
            return;
          }
          const gist = candidate.content.replace(/\s+/g, " ").slice(0, 60);
          notice(key === "a" ? `approved → ${overlay.scope}: ${gist}` : `rejected: ${gist}`);
          const next = removeCandidateAt(overlay.candidates, overlay.index);
          if (next.candidates.length === 0) {
            dispatch({ type: "overlay", overlay: null });
            notice("no more pending candidates");
          } else {
            dispatch({ type: "overlay", overlay: { ...overlay, candidates: next.candidates, index: next.index } });
          }
          return;
        }
      }
      const action = keys("overlay", stroke);
      const count =
        overlay.kind === "palette"
          ? paletteCommands.length
          : overlay.kind === "files"
            ? pickerFiles.length
            : overlay.kind === "sessions"
              ? overlay.ids.length
              : overlay.kind === "backtrack"
                ? overlay.targets.length
                : overlay.kind === "model"
                  ? overlay.ids.length
                  : overlay.kind === "args"
                    ? overlay.candidates.length
                    : overlay.kind === "theme"
                      ? overlay.ids.length
                      : overlay.kind === "candidates"
                        ? overlay.candidates.length
                        : 0;
      if (action === "overlay-up") {
        dispatch({ type: "overlay-move", delta: -1, count });
        return;
      }
      if (action === "overlay-down") {
        dispatch({ type: "overlay-move", delta: 1, count });
        return;
      }
      if (action === "overlay-close") {
        dispatch({ type: "overlay", overlay: null });
        return;
      }
      if (action === "overlay-accept") {
        if (overlay.kind === "palette") {
          acceptPaletteEntry(stroke.name === "return");
        } else if (overlay.kind === "files") {
          acceptFileEntry();
        } else if (overlay.kind === "sessions") {
          const id = overlay.ids[overlay.index];
          dispatch({ type: "overlay", overlay: null });
          if (id) {
            dispatch({ type: "set-session", sessionId: id });
            notice(`continuing session ${id} — your next message resumes it`);
          }
        } else if (overlay.kind === "backtrack") {
          const target = overlay.targets[overlay.index];
          dispatch({ type: "overlay", overlay: null });
          if (target) applyBacktrack(target, true);
        } else if (overlay.kind === "model") {
          const id = overlay.ids[overlay.index];
          dispatch({ type: "overlay", overlay: null });
          if (id && id !== "deepseek-reasoner") {
            dispatch({ type: "set-model", model: id });
            notice(`model: ${id} (session only — set "model" in config.json to persist)`);
          } else if (id === "deepseek-reasoner") {
            notice("deepseek-reasoner has no tool calling and cannot drive the agent", "error");
          }
        } else if (overlay.kind === "theme") {
          const id = overlay.ids[overlay.index];
          dispatch({ type: "overlay", overlay: null });
          if (id) {
            setAccent(loadTheme(id).accent);
            notice(`theme: ${id} (session only — set "accent" in config.json to persist)`);
          }
        } else if (overlay.kind === "args") {
          const candidate = overlay.candidates[overlay.index];
          if (!candidate) {
            dispatch({ type: "overlay", overlay: null });
            return;
          }
          if (stroke.name === "tab") {
            // Tab fills the argument and keeps editing (syncOverlay re-derives).
            applyEditor(replaceSlashArg(editor, overlay.anchor, candidate.value));
            return;
          }
          // Enter runs the command with the chosen argument immediately.
          const line = `/${overlay.command} ${candidate.value}`.trimEnd();
          applyEditor(emptyEditor());
          const parsed = parseInput(line);
          if (parsed.kind === "slash") handleSlash(parsed.command);
        }
        return;
      }
      if (
        overlay.kind === "sessions" ||
        overlay.kind === "backtrack" ||
        overlay.kind === "model" ||
        overlay.kind === "theme" ||
        overlay.kind === "candidates"
      )
        return; // modal
      // Anything else falls through: typing keeps filtering via the composer.
    }

    // 5. Global keys (user keybindings apply via the merged table).
    const globalAction = keys("global", stroke);
    if (globalAction === "cycle-approval") {
      cycleApproval();
      return;
    }
    if (globalAction === "scroll-up" || globalAction === "scroll-down") {
      dispatch({
        type: "scroll",
        delta: globalAction === "scroll-up" ? SCROLL_PAGE : -SCROLL_PAGE,
        max: Math.max(0, stateRef.current.items.length - VIEW_ITEMS),
      });
      return;
    }
    if (globalAction === "toggle-verbose") {
      dispatch({ type: "toggle-verbose" });
      return;
    }
    if (globalAction === "detach-run") {
      detachRun();
      return;
    }
    if (globalAction === "suspend") {
      suspend();
      return;
    }
    if (globalAction === "tab-new") {
      tabsDispatch({ type: "tab-new", model: modelRef.current });
      return;
    }
    if (globalAction === "tab-cycle") {
      tabsDispatch({ type: "tab-next" });
      return;
    }
    if (globalAction === "toggle-sidebar") {
      if (sidebar) {
        setSidebar(null);
      } else {
        const nodes = buildTree(ensureFiles());
        setSidebar({ nodes, expanded: new Set<string>(), cursor: 0, focused: true });
      }
      return;
    }
    if (globalAction === "toggle-pager") {
      setPager({ lines: pagerLines(stateRef.current.items), offset: 0 });
      return;
    }
    if (stroke.name === "escape") {
      if (controllerRef.current) {
        controllerRef.current.abort();
        if (stateRef.current.queue.length > 0) dispatch({ type: "queue-clear" });
        notice("cancelling… (session stays open)");
        return;
      }
      if (stateRef.current.scrollOffset > 0) {
        dispatch({ type: "scroll-latest" });
        return;
      }
      if (!vimOn) {
        if (editor.text !== "") {
          applyEditor(clearAll(editor));
        } else {
          // Double-Esc on an empty idle composer opens the backtrack picker.
          const now = Date.now();
          if (now - lastEscRef.current < 600) {
            lastEscRef.current = 0;
            handleSlash({ name: "backtrack" });
          } else {
            lastEscRef.current = now;
          }
        }
        return;
      }
      // vim mode: Esc falls through to the composer branch (enters NORMAL).
    }

    // 6. Composer. Stays live during a run: Enter queues a follow-up
    // (steering); slash/! commands execute immediately.
    if (vimOn) {
      const vimName =
        stroke.name === "escape" ||
        stroke.name === "return" ||
        stroke.name === "backspace" ||
        stroke.name === "up" ||
        stroke.name === "down" ||
        stroke.name === "left" ||
        stroke.name === "right" ||
        stroke.name === "tab"
          ? stroke.name
          : undefined;
      const result = applyVimKey(vim, editor, {
        input: rawInput,
        ...(vimName ? { name: vimName } : {}),
        ...(key.ctrl ? { ctrl: true } : {}),
      });
      if (result.vim !== vim) setVim(result.vim);
      if (!result.passthrough) {
        applyEditor(result.editor);
        return;
      }
    }
    const action = keys("composer", stroke);
    switch (action) {
      case "submit":
        if (endsWithContinuation(editor)) {
          applyEditor(insertText(backspace(editor), "\n"));
        } else {
          handleSubmit();
        }
        return;
      case "newline":
        applyEditor(insertText(editor, "\n"));
        return;
      case "history-up": {
        if (!isOnFirstLine(editor)) {
          applyEditor(moveUp(editor));
          return;
        }
        const prev = historyNavRef.current?.up(editor.text);
        if (typeof prev === "string") applyEditor(setText(prev));
        return;
      }
      case "history-down": {
        if (!isOnLastLine(editor)) {
          applyEditor(moveDown(editor));
          return;
        }
        const next = historyNavRef.current?.down();
        if (typeof next === "string") applyEditor(setText(next));
        return;
      }
      case "cursor-left":
        applyEditor(moveLeft(editor));
        return;
      case "cursor-right": {
        if (editor.cursor === editor.text.length) {
          const g = ghostSuggestion(editor.text, historyEntriesRef.current);
          if (g) {
            applyEditor(insertText(editor, g));
            return;
          }
        }
        applyEditor(moveRight(editor));
        return;
      }
      case "clear-line":
        applyEditor(clearAll(editor));
        return;
      case "delete-back":
        applyEditor(backspace(editor));
        return;
      case "delete-forward":
        applyEditor(deleteForward(editor));
        return;
      case "external-editor":
        openExternalEditor();
        return;
      case "history-search":
        searchEntriesRef.current = loadHistory(historyFile);
        setSearch(startSearch());
        return;
      case "paste-image": {
        const captured = captureClipboardImage(projectPath);
        if (!captured) {
          notice("no image on the clipboard (text paste works as usual)");
          return;
        }
        imageCounterRef.current += 1;
        applyEditor(insertText(editor, imagePlaceholder(imageCounterRef.current, captured.path)));
        notice(`image saved → ${captured.path}`);
        return;
      }
      case "path-complete": {
        const existing = completionRef.current;
        if (existing && existing.candidates.length > 0) {
          const cycled = cycleCompletion(existing);
          applyEditor(applyCompletion(editor, cycled));
          completionRef.current = cycled;
          return;
        }
        const completion = startCompletion(editor, ensureFiles());
        if (!completion) return;
        applyEditor(applyCompletion(editor, completion));
        completionRef.current = completion;
        return;
      }
      default:
        break;
    }
    // Printable input (including multi-char paste; Ink delivers paste as one
    // chunk). Big pastes collapse into a placeholder token, expanded on send.
    if (rawInput.length > 0 && !key.ctrl && !key.meta) {
      if (rawInput.length > 1 && shouldPlaceholder(rawInput)) {
        applyEditor(insertText(editor, registerPaste(pasteRegistryRef.current, rawInput)));
        return;
      }
      applyEditor(insertText(editor, rawInput));
    }
  });

  const bgRunning = state.bgTasks.filter((t) => t.status === "running").length;
  // Ghost autocompletion from history (→ at end of input accepts).
  const ghost =
    editor.cursor === editor.text.length && !state.permission
      ? ghostSuggestion(editor.text, historyEntriesRef.current)
      : null;
  // The shell command currently executing (for the under-input mode line).
  const runningShell = useMemo(() => {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
      const it = state.items[i];
      if (it?.kind === "tool" && it.toolName === "run_command" && it.status === "running") {
        const cmd = (it.args as { command?: unknown })?.command;
        return typeof cmd === "string" ? cmd : "(command)";
      }
    }
    return null;
  }, [state.items]);

  return (
    <Box flexDirection="column">
      {tabsState.tabs.length > 1 ? (
        <Box>
          {tabLabels(tabsState).map((label, i) => (
            <Text key={i} inverse={i === tabsState.active} color={i === tabsState.active ? ACCENT : undefined} dimColor={i !== tabsState.active}>
              {" "}
              {label}{" "}
            </Text>
          ))}
          <Text dimColor>  Ctrl+T switch · Ctrl+N new · /tab close</Text>
        </Box>
      ) : null}
      <Header projectPath={projectPath} model={state.model} {...(version ? { version } : {})} />
      {pager ? (
        <Pager
          lines={pager.lines}
          offset={Math.min(pager.offset, Math.max(0, pager.lines.length - 1))}
          height={20}
        />
      ) : (
        <Box>
          {sidebar ? (
            <Sidebar
              visible={visibleNodes(sidebar.nodes, sidebar.expanded)}
              cursor={sidebar.cursor}
              focused={sidebar.focused}
            />
          ) : null}
          <Box flexDirection="column" flexGrow={1}>
            <Transcript items={state.items} offset={state.scrollOffset} size={VIEW_ITEMS} verbose={state.verbose} />
          </Box>
        </Box>
      )}
      {state.permission ? (
        <PermissionPanel
          request={state.permission}
          hunkSelection={
            state.permission.hunks && state.permission.hunks.length > 1 ? hunkSelection : undefined
          }
        />
      ) : null}
      {state.overlay?.kind === "question" ? (
        <QuestionPanel question={state.overlay.question} options={state.overlay.options} index={state.overlay.index} />
      ) : null}
      {state.overlay?.kind === "context" ? (
        <ContextInspector
          {...(state.context ? { context: state.context } : {})}
          usage={state.totalUsage}
          itemCount={state.items.length}
          items={state.items}
          {...(state.sessionId ? { sessionId: state.sessionId } : {})}
          model={state.model}
          bgTasks={state.bgTasks}
        />
      ) : null}
      {state.planPending && !state.running ? (
        <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT}>Execute this plan? </Text>
          <Text dimColor>y runs it · any other key keeps planning</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <StatusBar
          model={state.model}
          {...(state.context ? { context: state.context } : {})}
          usage={state.totalUsage}
          running={state.running}
          approval={state.approval}
          bgRunning={bgRunning}
          scrolled={state.scrollOffset > 0}
          {...(vimOn ? { vim: vim.mode } : {})}
          detachedRuns={state.detached.length}
          {...(state.turnStartedAt !== undefined ? { turnStartedAt: state.turnStartedAt } : {})}
          turnTokens={state.turnTokens}
          {...(state.retryStatus ? { retryStatus: state.retryStatus } : {})}
        />
        {state.overlay?.kind === "palette" ? <Palette commands={paletteCommands} index={state.overlay.index} /> : null}
        {state.overlay?.kind === "files" ? (
          <FilePicker files={pickerFiles} index={state.overlay.index} query={state.overlay.query} />
        ) : null}
        {state.overlay?.kind === "sessions" ? (
          <ListOverlay
            title={t("picker.titleSessions")}
            lines={state.overlay.lines}
            index={state.overlay.index}
            footer={t("picker.resume")}
          />
        ) : null}
        {state.overlay?.kind === "backtrack" ? (
          <ListOverlay
            title={t("picker.titleBacktrack")}
            lines={state.overlay.targets.map(
              (t) => `turn ${t.turn}: ${t.text.replace(/\s+/g, " ").slice(0, 64)}${t.text.length > 64 ? "…" : ""}`,
            )}
            index={state.overlay.index}
            footer={t("picker.rewind")}
          />
        ) : null}
        {state.overlay?.kind === "model" ? (
          <ListOverlay
            title={t("picker.titleModel")}
            lines={state.overlay.lines}
            index={state.overlay.index}
            footer={t("picker.model")}
          />
        ) : null}
        {state.overlay?.kind === "theme" ? (
          <ListOverlay
            title={t("picker.titleTheme")}
            lines={state.overlay.lines}
            index={state.overlay.index}
            footer={t("picker.theme")}
          />
        ) : null}
        {state.overlay?.kind === "candidates" ? (
          <ListOverlay
            title={`${t("picker.titleCandidates")} (scope: ${state.overlay.scope})`}
            lines={state.overlay.candidates.map(formatCandidateLine)}
            index={state.overlay.index}
            footer={t("picker.candidates")}
          />
        ) : null}
        {state.overlay?.kind === "args" ? (
          <ListOverlay
            title={`/${state.overlay.command}`}
            lines={state.overlay.candidates.map(
              (c) => `${(c.value || "(no argument)").padEnd(26)} ${c.hint ?? ""}`.trimEnd(),
            )}
            index={state.overlay.index}
            footer={t("picker.history")}
          />
        ) : null}
        {state.overlay?.kind === "help" ? (
          <ListOverlay
            title={t("picker.titleCommands")}
            lines={state.overlay.lines}
            index={state.overlay.selectable[state.overlay.index] ?? 0}
            footer={t("picker.slash")}
          />
        ) : null}
        {search ? (
          <Text>
            <Text color={ACCENT}>(reverse-i-search)</Text>
            <Text> `{search.query}`: </Text>
            {currentMatch(search, searchEntriesRef.current) ?? <Text dimColor>no match</Text>}
          </Text>
        ) : null}
        {state.queue.length > 0 ? (
          <Text dimColor>
            queued ({state.queue.length}): {state.queue[0]?.slice(0, 60)}
            {state.queue.length > 1 || (state.queue[0]?.length ?? 0) > 60 ? "…" : ""}
          </Text>
        ) : null}
        <MultilineComposer
          editor={editor}
          disabled={!!state.permission}
          {...(ghost ? { ghost } : {})}
          placeholder={state.running ? t("composer.running") : t("composer.idle")}
        />
        {/* Claude Code-style mode line under the input box. */}
        {state.approval !== "confirm" ? (
          <Text color={state.approval === "auto" ? "yellow" : state.approval === "acceptEdits" ? "green" : "magenta"}>
            {state.approval === "auto"
              ? `⏵⏵ ${t("mode.autoApprove")}`
              : state.approval === "acceptEdits"
                ? `⏵ ${t("mode.acceptEdits")}`
                : `⏸ ${t("mode.plan")}`}
            <Text dimColor> {t("mode.cycleHint")}</Text>
          </Text>
        ) : null}
        {runningShell || bgRunning > 0 || state.detached.length > 0 ? (
          <Text dimColor>
            {runningShell ? `⚙ running: ${runningShell.slice(0, 60)}` : null}
            {runningShell && (bgRunning > 0 || state.detached.length > 0) ? "  ·  " : null}
            {bgRunning > 0 ? `${bgRunning} background task${bgRunning > 1 ? "s" : ""}` : null}
            {bgRunning > 0 && state.detached.length > 0 ? "  ·  " : null}
            {state.detached.length > 0 ? `${state.detached.length} detached run${state.detached.length > 1 ? "s" : ""}` : null}
          </Text>
        ) : null}
        {statusLineText ? <Text dimColor>{statusLineText}</Text> : null}
        <Text dimColor>
          {state.sessionId ? (
            <>
              session <Text color={ACCENT}>{state.sessionId.slice(0, 8)}</Text>
              {" · "}
            </>
          ) : null}
          {keyHints(state.permission ? "permission" : state.running ? "running" : "idle")}
        </Text>
      </Box>
    </Box>
  );
}
