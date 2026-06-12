import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  addMemoryFact,
  compactSessionNow,
  createBackgroundTasks,
  listProjectFacts,
  listSessions,
  loadAgentDefinitions,
  projectMemoryPath,
  forkSession,
  listMcpResources,
  readMcpResource,
  readSessionMeta,
  rewindSession,
  rewindSessionToTurn,
  sessionTitle,
  truncateSessionAtUserTurn,
  BUILTIN_COMMAND_ALLOWLIST,
  type BackgroundTasks,
  type McpClientEntry,
  type ToolSpec,
} from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "./config.js";
import { chatReducer, initialState, type ApprovalSetting, type ChatAction, type Overlay } from "./model.js";
import { formatUsageDetail, kfmt } from "./format.js";
import { COMMANDS, parseInput, type CommandSpec, type SlashCommand } from "./commands.js";
import { argCandidates, type ArgContext } from "./arg-values.js";
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
import { KNOWN_MODELS, modelPickerLines } from "./model-list.js";
import { addTodo, formatTodoLines, loadTodos, removeTodo, toggleTodo } from "./todos.js";
import { expandExtraFileRefs, formatExtraDirLines, normalizeExtraDir } from "./workspace-dirs.js";
import { runStatusLine } from "./statusline.js";
import { checkBudget, type BudgetState } from "./budget.js";
import { detectTerminal, terminalSetupInstructions } from "./terminal-setup.js";
import { keyHints, turnSummaryLine } from "./render-helpers.js";
import { runSession } from "./agent/run-session.js";
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
import { classifyUnifiedDiff } from "./diff.js";
import { createDefaultProbes, formatDoctorLines, runDoctor } from "./doctor.js";
import { transcriptToMarkdown, defaultExportPath } from "./export.js";
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
import { openInExternalEditor } from "./external-editor.js";
import { copyToClipboard } from "./clipboard.js";
import { Header, ACCENT } from "./components/Header.js";
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
};

type PendingPermission = {
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
};

/** Items scrolled per PageUp/PageDown press. */
const SCROLL_PAGE = 10;
/** Rendered transcript window (older items are virtualized away). */
const VIEW_ITEMS = 40;

const EXECUTE_PLAN_PROMPT =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";

const APPROVAL_CYCLE: ApprovalSetting[] = ["confirm", "auto", "plan"];

export function App({
  config,
  projectPath,
  initialModel,
  mcpToolSpecs,
  mcpEntries = [],
  initialSessionId,
  version,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { setRawMode } = useStdin();
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialState(initialModel));
  const [editor, setEditor] = useState<EditorState>(emptyEditor());

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

  const controllerRef = useRef<AbortController | null>(null);
  const pendingPermissionRef = useRef<PendingPermission | null>(null);
  const sigintCountRef = useRef(0);

  // Ctrl+B run detachment: ids of runs sent to the background, their
  // controllers (aborted on quit), and the per-run id counter.
  const runIdCounterRef = useRef(0);
  const currentRunIdRef = useRef<number | null>(null);
  const detachedRunsRef = useRef<Set<number>>(new Set());
  const detachedControllersRef = useRef<Map<number, AbortController>>(new Map());

  // ask_user tool: the pending question's resolver.
  const pendingQuestionRef = useRef<((answer: string) => void) | null>(null);

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

  // Extra read-only roots for @ references (/add-dir).
  const extraDirsRef = useRef<string[]>([]);
  // Palette ranking: commands used this session float to the top.
  const usageRef = useRef<CommandUsage>({});
  const versionRef = useRef(version);
  const lastErrorRef = useRef<string | null>(null);
  // Cost-budget warning state (80% / 100%, warned once each).
  const budgetRef = useRef<BudgetState>({ warned80: false, warnedOver: false });
  // Custom statusline output (config.statusLine command), refreshed per run.
  const [statusLineText, setStatusLineText] = useState<string | null>(null);

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
    bgRef.current?.disposeAll();
    process.stdout.write(MOUSE_DISABLE);
    clearTerminalTitle();
    exit();
  }, [exit]);

  // Mouse-wheel tracking + terminal title for the app's lifetime.
  useEffect(() => {
    process.stdout.write(MOUSE_ENABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
      clearTerminalTitle();
    };
  }, []);
  useEffect(() => {
    const name = projectPath.split("/").filter(Boolean).pop() ?? "seekforge";
    setTerminalTitle(`seekforge — ${name}${state.running ? " ⚙" : ""}`);
  }, [projectPath, state.running]);

  // Ctrl+Z suspend: restore the terminal, stop, and re-enter raw mode on fg.
  useEffect(() => {
    const onCont = (): void => {
      setRawMode(true);
      process.stdout.write(MOUSE_ENABLE);
    };
    process.on("SIGCONT", onCont);
    return () => {
      process.removeListener("SIGCONT", onCont);
    };
  }, [setRawMode]);

  const suspend = useCallback(() => {
    setRawMode(false);
    process.stdout.write(MOUSE_DISABLE);
    process.kill(process.pid, "SIGTSTP");
  }, [setRawMode]);

  const notice = useCallback((text: string, tone?: "dim" | "error") => {
    dispatch(tone ? { type: "notice", text, tone } : { type: "notice", text });
  }, []);

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
  if (historyNavRef.current === null) {
    historyNavRef.current = createHistoryNav(loadHistory(historyFile));
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
      models: [...KNOWN_MODELS],
      memoryFactCount: listProjectFacts(projectPath).length,
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
    ];
    return rankCommands(state.overlay.query, all, usageRef.current, 24);
  }, [state.overlay]);

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
      const label = task.replace(/\s+/g, " ").slice(0, 48);
      const detached = (): boolean => detachedRunsRef.current.has(runId);
      // Detached runs stay silent except for their final outcome.
      const dispatchRun = (a: ChatAction): void => {
        if (!detached()) {
          dispatch(a);
          return;
        }
        if (a.type === "event" && a.event.type === "session.completed") {
          const summary = a.event.report.summary.split("\n")[0] ?? "done";
          dispatch({ type: "notice", text: `⚒ background task done: ${summary.slice(0, 100)}` });
        } else if (a.type === "event" && a.event.type === "session.failed") {
          dispatch({ type: "notice", tone: "error", text: `⚒ background task failed: ${a.event.error.message}` });
        }
      };
      controllerRef.current = controller;
      currentRunIdRef.current = runId;
      sigintCountRef.current = 0;
      // The session this run owns: detaching frees the UI's sessionId for a
      // fresh session, so the run must keep resolving its own.
      const ownSessionId = { current: sessionIdRef.current };
      const startedAt = Date.now();
      const costBefore = stateRef.current.totalUsage.costUsd;
      if (opts?.echoUser !== false) dispatch({ type: "user", text: task });
      dispatch({ type: "run-start" });
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
            dispatch({
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
          approvalMode: approvalRef.current === "auto" ? "auto" : "confirm",
          background: bgRef.current as BackgroundTasks,
          dispatch: (a: ChatAction) => {
            if (a.type === "event" && a.event.type === "session.created") ownSessionId.current = a.event.sessionId;
            dispatchRun(a);
          },
          getSessionId: () => ownSessionId.current,
          confirm: (req) =>
            new Promise<boolean>((resolve) => {
              if (detached()) {
                dispatch({
                  type: "notice",
                  tone: "error",
                  text: `⚒ background task asked permission for ${req.toolName} — denied (foreground only)`,
                });
                resolve(false);
                return;
              }
              pendingPermissionRef.current = { request: req, resolve };
              dispatch({ type: "permission", request: req });
              ring(`Permission needed: ${req.toolName}${req.command ? ` — ${req.command.slice(0, 60)}` : ""}`);
            }),
          askUser: (q) =>
            new Promise<string>((resolve) => {
              if (detached()) {
                resolve("(no answer — the session was moved to the background)");
                return;
              }
              pendingQuestionRef.current = resolve;
              dispatch({
                type: "overlay",
                overlay: { kind: "question", question: q.question, options: [...q.options], index: 0 },
              });
              ring(`Question: ${q.question.slice(0, 60)}`);
            }),
        });
        if (opts?.plan && !controller.signal.aborted && !detached()) {
          dispatch({ type: "plan-pending", pending: true });
          dispatch({ type: "notice", text: "Execute this plan? press y to run it, any other key to keep planning" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastErrorRef.current = message;
        if (!controller.signal.aborted && !detached()) {
          dispatch({ type: "notice", tone: "error", text: `error: ${message}` });
        }
      } finally {
        // If a permission prompt was still open when the run ended, deny it.
        if (pendingPermissionRef.current && currentRunIdRef.current === runId) {
          pendingPermissionRef.current.resolve(false);
          pendingPermissionRef.current = null;
          dispatch({ type: "permission-resolved" });
        }
        if (detached()) {
          detachedRunsRef.current.delete(runId);
          detachedControllersRef.current.delete(runId);
          dispatch({ type: "run-detach-done", label });
        } else {
          controllerRef.current = null;
          currentRunIdRef.current = null;
          dispatch({ type: "run-end" });
          // Turn summary + budget + custom statusline (foreground runs only).
          if (!controller.signal.aborted) {
            const s = stateRef.current;
            dispatch({
              type: "notice",
              text: turnSummaryLine({
                durationMs: Date.now() - startedAt,
                costUsd: Math.max(0, s.totalUsage.costUsd - costBefore),
                totalTokens: s.turnTokens,
              }),
            });
            const budget = checkBudget(budgetRef.current, s.totalUsage.costUsd, config.costBudgetUsd);
            budgetRef.current = budget.state;
            if (budget.warning) dispatch({ type: "notice", tone: "error", text: budget.warning });
            if (config.statusLine) {
              setStatusLineText(
                runStatusLine(config.statusLine, {
                  model: modelRef.current,
                  cwd: projectPath,
                  ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
                  costUsd: s.totalUsage.costUsd,
                  ...(s.context ? { contextPercent: s.context.percent } : {}),
                }),
              );
            }
          }
        }
        syncBg();
        ring(`Task finished: ${task.slice(0, 60)}`);
      }
    },
    [projectPath, mcpToolSpecs, syncBg, ring, config.costBudgetUsd, config.statusLine],
  );

  /** Ctrl+B: detach the current run; chat continues in a fresh session. */
  const detachRun = useCallback(() => {
    const runId = currentRunIdRef.current;
    const controller = controllerRef.current;
    if (runId === null || !controller) {
      notice("nothing to detach — no task is running");
      return;
    }
    detachedRunsRef.current.add(runId);
    detachedControllersRef.current.set(runId, controller);
    controllerRef.current = null;
    currentRunIdRef.current = null;
    // A pending permission would block the detached run forever: deny it now.
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current.resolve(false);
      pendingPermissionRef.current = null;
      dispatch({ type: "permission-resolved" });
    }
    if (pendingQuestionRef.current) {
      pendingQuestionRef.current("(no answer — the session was moved to the background)");
      pendingQuestionRef.current = null;
      dispatch({ type: "overlay", overlay: null });
    }
    dispatch({ type: "run-detach", label: "task" });
  }, [notice]);

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
        case "clear":
          dispatch({ type: "clear" });
          syncBg();
          notice("transcript cleared — next message starts a fresh session");
          break;
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
        case "approve": {
          if (!command.arg) {
            notice(`approval mode: ${approvalRef.current} (auto | confirm | plan — Shift+Tab cycles)`);
            break;
          }
          if (command.arg === "auto" || command.arg === "confirm" || command.arg === "plan") {
            dispatch({ type: "set-approval", approval: command.arg });
            notice(`approval mode: ${command.arg}`);
          } else {
            notice("usage: /approve [auto|confirm|plan]", "error");
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
          break;
        }
        case "model":
          if (!command.arg) {
            dispatch({
              type: "overlay",
              overlay: {
                kind: "model",
                ids: KNOWN_MODELS.map((m) => m.id),
                lines: modelPickerLines(KNOWN_MODELS, modelRef.current),
                index: Math.max(0, KNOWN_MODELS.findIndex((m) => m.id === modelRef.current)),
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
          if (command.arg === "edit") {
            setRawMode(false);
            const r = spawnSync(process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi", [projectMemoryPath(projectPath)], {
              stdio: "inherit",
            });
            setRawMode(true);
            if (r.error) notice(`editor failed: ${r.error.message}`, "error");
            else notice("project memory saved");
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
        case "doctor":
          notice("doctor:");
          for (const line of formatDoctorLines(runDoctor(projectPath, config, createDefaultProbes()))) {
            notice(`  ${line}`);
          }
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
          const report = buildBugReport({
            ...(versionRef.current ? { version: versionRef.current } : {}),
            platform: process.platform,
            nodeVersion: process.version,
            model: modelRef.current,
            doctorLines: formatDoctorLines(runDoctor(projectPath, config, createDefaultProbes())),
            ...(lastErrorRef.current ? { lastError: lastErrorRef.current } : {}),
          });
          const copied = copyToClipboard(report);
          notice(copied ? "bug report copied to the clipboard — paste it into a GitHub issue:" : "clipboard unavailable — report follows:", "dim");
          notice("  https://github.com/eilyeee/seekforge/issues/new");
          if (!copied) for (const l of report.split("\n").slice(0, 30)) notice(`  ${l}`);
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
          const suggestion = didYouMean(head ?? "", [
            ...COMMANDS,
            ...customCommandSpecs(customCommandsRef.current ?? []),
            ...skillCommandSpecs(skillRowsRef.current ?? []),
          ]);
          notice(
            `unknown command ${command.raw}${suggestion ? ` — did you mean /${suggestion}?` : ""} (/help lists all)`,
            "error",
          );
          break;
        }
      }
    },
    [notice, projectPath, config.mcpServers, mcpToolSpecs, runTask, openExternalEditor, quit, syncBg, setRawMode],
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
    historyNavRef.current = createHistoryNav(loadHistory(historyFile));
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
          dispatch({ type: "user", text: `/${spec.name}` });
          void runTask(expandCustomCommand(custom, ""), { echoUser: false });
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
    const idx = APPROVAL_CYCLE.indexOf(approvalRef.current);
    const next = APPROVAL_CYCLE[(idx + 1) % APPROVAL_CYCLE.length] ?? "confirm";
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
          max: Math.max(0, stateRef.current.items.length - 1),
        });
      }
      return;
    }

    // 1. Permission prompt: y allow once / a allow for session / anything else deny.
    if (pendingPermissionRef.current) {
      const pending = pendingPermissionRef.current;
      const choice = rawInput.toLowerCase();
      let approved = false;
      if (choice === "y") {
        approved = true;
      } else if (choice === "a") {
        approved = true;
        if (pending.request.command) {
          const prefix = sessionAllowPrefix(pending.request.command);
          if (prefix && !allowlistRef.current.includes(prefix)) {
            allowlistRef.current.push(prefix);
            notice(`allowed for this session: ${prefix} …`);
          }
        }
      }
      pendingPermissionRef.current = null;
      dispatch({ type: "permission-resolved" });
      pending.resolve(approved);
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
          pendingQuestionRef.current = null;
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
            notice(`model: ${id}`);
          } else if (id === "deepseek-reasoner") {
            notice("deepseek-reasoner has no tool calling and cannot drive the agent", "error");
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
      if (overlay.kind === "sessions" || overlay.kind === "backtrack" || overlay.kind === "model") return; // modal
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
        max: Math.max(0, stateRef.current.items.length - 1),
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
      case "cursor-right":
        applyEditor(moveRight(editor));
        return;
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

  return (
    <Box flexDirection="column">
      <Header projectPath={projectPath} model={state.model} {...(version ? { version } : {})} />
      <Transcript items={state.items} offset={state.scrollOffset} size={VIEW_ITEMS} verbose={state.verbose} />
      {state.permission ? <PermissionPanel request={state.permission} /> : null}
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
        />
        {state.overlay?.kind === "palette" ? <Palette commands={paletteCommands} index={state.overlay.index} /> : null}
        {state.overlay?.kind === "files" ? (
          <FilePicker files={pickerFiles} index={state.overlay.index} query={state.overlay.query} />
        ) : null}
        {state.overlay?.kind === "sessions" ? (
          <ListOverlay
            title="Sessions"
            lines={state.overlay.lines}
            index={state.overlay.index}
            footer="↑↓ select · Enter resume · f fork · Esc dismiss"
          />
        ) : null}
        {state.overlay?.kind === "backtrack" ? (
          <ListOverlay
            title="Backtrack — rewind the conversation to…"
            lines={state.overlay.targets.map(
              (t) => `turn ${t.turn}: ${t.text.replace(/\s+/g, " ").slice(0, 64)}${t.text.length > 64 ? "…" : ""}`,
            )}
            index={state.overlay.index}
            footer="↑↓ select · Enter rewind conversation+files · c conversation only · Esc dismiss"
          />
        ) : null}
        {state.overlay?.kind === "model" ? (
          <ListOverlay
            title="Model"
            lines={state.overlay.lines}
            index={state.overlay.index}
            footer="↑↓ select · Enter switch · Esc dismiss"
          />
        ) : null}
        {state.overlay?.kind === "args" ? (
          <ListOverlay
            title={`/${state.overlay.command}`}
            lines={state.overlay.candidates.map(
              (c) => `${(c.value || "(no argument)").padEnd(26)} ${c.hint ?? ""}`.trimEnd(),
            )}
            index={state.overlay.index}
            footer="↑↓ select · Tab fill · Enter run · Esc dismiss"
          />
        ) : null}
        {state.overlay?.kind === "help" ? (
          <ListOverlay
            title="Commands"
            lines={state.overlay.lines}
            index={state.overlay.selectable[state.overlay.index] ?? 0}
            footer="↑↓ select · Enter insert · Esc close — @ files · # remember · ! shell · Shift+Tab approval"
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
          placeholder={
            state.running
              ? "working… type to queue a follow-up · Esc cancels · ! runs shell"
              : "Ask SeekForge to do something…  (/ commands · @ files · # remember · ! shell)"
          }
        />
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
