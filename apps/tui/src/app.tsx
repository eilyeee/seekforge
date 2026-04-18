import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  addMemoryFact,
  compactSessionNow,
  createBackgroundTasks,
  listProjectFacts,
  listSessions,
  loadAgentDefinitions,
  projectMemoryPath,
  readSessionMeta,
  rewindSession,
  truncateSessionAtUserTurn,
  type BackgroundTasks,
  type ToolSpec,
} from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "./config.js";
import { chatReducer, initialState, type ApprovalSetting, type ChatAction, type Overlay } from "./model.js";
import { formatUsage, kfmt } from "./format.js";
import { COMMANDS, HELP_LINES, parseInput, type SlashCommand } from "./commands.js";
import { resolveAction, toStroke, type InkKey, type KeyStroke } from "./keymap.js";
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
  setText,
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

export type AppProps = {
  config: TuiConfig;
  projectPath: string;
  initialModel: string;
  mcpToolSpecs: ToolSpec[];
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

export function App({ config, projectPath, initialModel, mcpToolSpecs }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { setRawMode } = useStdin();
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialState(initialModel));
  const [editor, setEditor] = useState<EditorState>(emptyEditor());

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
    bgRef.current?.disposeAll();
    exit();
  }, [exit]);

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

  const syncOverlay = useCallback(
    (next: EditorState) => {
      const current = stateRef.current.overlay;
      if (current?.kind === "context") return; // modal; closes via Esc only
      const slash = slashPrefix(next);
      if (slash !== null) {
        const index = current?.kind === "palette" && current.query === slash ? current.index : 0;
        dispatch({ type: "overlay", overlay: { kind: "palette", query: slash, index } });
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
    [ensureFiles],
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
    return fuzzyRank(state.overlay.query, COMMANDS, (c) => c.name, 24);
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
      controllerRef.current = controller;
      sigintCountRef.current = 0;
      if (opts?.echoUser !== false) dispatch({ type: "user", text: task });
      dispatch({ type: "run-start" });
      try {
        await runSession(task, controller.signal, {
          config: runConfigRef.current,
          model: modelRef.current,
          projectPath,
          mcpToolSpecs,
          mode: opts?.mode ?? "edit",
          plan: opts?.plan ?? false,
          approvalMode: approvalRef.current === "auto" ? "auto" : "confirm",
          background: bgRef.current as BackgroundTasks,
          dispatch: dispatch as (a: ChatAction) => void,
          getSessionId: () => sessionIdRef.current,
          confirm: (req) =>
            new Promise<boolean>((resolve) => {
              pendingPermissionRef.current = { request: req, resolve };
              dispatch({ type: "permission", request: req });
              ring(`Permission needed: ${req.toolName}${req.command ? ` — ${req.command.slice(0, 60)}` : ""}`);
            }),
        });
        if (opts?.plan && !controller.signal.aborted) {
          dispatch({ type: "plan-pending", pending: true });
          dispatch({ type: "notice", text: "Execute this plan? press y to run it, any other key to keep planning" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!controller.signal.aborted) dispatch({ type: "notice", tone: "error", text: `error: ${message}` });
      } finally {
        // If a permission prompt was still open when the run ended, deny it.
        if (pendingPermissionRef.current) {
          pendingPermissionRef.current.resolve(false);
          pendingPermissionRef.current = null;
          dispatch({ type: "permission-resolved" });
        }
        controllerRef.current = null;
        dispatch({ type: "run-end" });
        syncBg();
        ring(`Task finished: ${task.slice(0, 60)}`);
      }
    },
    [projectPath, mcpToolSpecs, syncBg, ring],
  );

  const submitTask = useCallback(
    (task: string) => {
      if (approvalRef.current === "plan") {
        void runTask(task, { mode: "ask", plan: true });
      } else {
        void runTask(task);
      }
    },
    [runTask],
  );

  // ---------------------------------------------------------------------
  // Slash commands.
  // ---------------------------------------------------------------------

  const notice = useCallback((text: string, tone?: "dim" | "error") => {
    dispatch(tone ? { type: "notice", text, tone } : { type: "notice", text });
  }, []);

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
      switch (command.name) {
        case "help":
          notice("Slash commands:");
          for (const [cmd, desc] of HELP_LINES) notice(`  ${cmd.padEnd(22)} ${desc}`);
          notice("  @path opens the file picker · # <fact> remembers · Shift+Tab cycles approval");
          break;
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
          dispatch({
            type: "overlay",
            overlay: {
              kind: "sessions",
              ids: metas.map((m) => m.id),
              lines: formatSessionLines(metas, 50),
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
            notice(`model: ${modelRef.current}`);
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
        case "usage":
          notice(formatUsage(stateRef.current.totalUsage));
          break;
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
        case "quit":
          quit();
          break;
        case "unknown":
          notice(`unknown command ${command.raw} — /help for the list`, "error");
          break;
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
    const raw = editor.text;
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

    // 4. Overlay scope (palette / file picker / context inspector).
    const overlay = stateRef.current.overlay;
    if (overlay) {
      if (overlay.kind === "context") {
        if (stroke.name === "escape" || stroke.name === "return" || rawInput === "q") {
          dispatch({ type: "overlay", overlay: null });
        }
        return;
      }
      const action = resolveAction("overlay", stroke);
      const count =
        overlay.kind === "palette"
          ? paletteCommands.length
          : overlay.kind === "files"
            ? pickerFiles.length
            : overlay.kind === "sessions"
              ? overlay.ids.length
              : overlay.kind === "backtrack"
                ? overlay.targets.length
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
          if (target) {
            const sessionId = sessionIdRef.current;
            const result = sessionId ? truncateSessionAtUserTurn(projectPath, sessionId, target.turn) : null;
            if (!result) {
              notice("backtrack failed — the stored session no longer matches this transcript", "error");
              return;
            }
            dispatch({ type: "backtrack-apply", itemIndex: target.itemIndex });
            applyEditor(setText(target.text));
            notice(
              `rewound to turn ${target.turn} (${result.removedMessages} messages dropped); ` +
                "file changes were NOT reverted — /rewind covers files",
            );
          }
        }
        return;
      }
      if (overlay.kind === "sessions" || overlay.kind === "backtrack") return; // modal: plain typing is ignored
      // Anything else falls through: typing keeps filtering via the composer.
    }

    // 5. Global keys.
    if (stroke.name === "tab" && stroke.shift) {
      cycleApproval();
      return;
    }
    if (stroke.name === "pageup") {
      dispatch({ type: "scroll", delta: SCROLL_PAGE, max: Math.max(0, stateRef.current.items.length - 1) });
      return;
    }
    if (stroke.name === "pagedown") {
      dispatch({ type: "scroll", delta: -SCROLL_PAGE, max: Math.max(0, stateRef.current.items.length - 1) });
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
    const action = resolveAction("composer", stroke);
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
    // Printable input (including multi-char paste; Ink delivers paste as one chunk).
    if (rawInput.length > 0 && !key.ctrl && !key.meta) {
      applyEditor(insertText(editor, rawInput));
    }
  });

  const bgRunning = state.bgTasks.filter((t) => t.status === "running").length;

  return (
    <Box flexDirection="column">
      <Header projectPath={projectPath} model={state.model} />
      <Transcript items={state.items} offset={state.scrollOffset} size={VIEW_ITEMS} />
      {state.permission ? <PermissionPanel request={state.permission} /> : null}
      {state.overlay?.kind === "context" ? (
        <ContextInspector
          {...(state.context ? { context: state.context } : {})}
          usage={state.totalUsage}
          itemCount={state.items.length}
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
            footer="↑↓ select · Enter resume · Esc dismiss"
          />
        ) : null}
        {state.overlay?.kind === "backtrack" ? (
          <ListOverlay
            title="Backtrack — rewind the conversation to…"
            lines={state.overlay.targets.map(
              (t) => `turn ${t.turn}: ${t.text.replace(/\s+/g, " ").slice(0, 64)}${t.text.length > 64 ? "…" : ""}`,
            )}
            index={state.overlay.index}
            footer="↑↓ select · Enter rewind (files NOT reverted) · Esc dismiss"
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
        <Text dimColor>
          {state.sessionId ? (
            <>
              session <Text color={ACCENT}>{state.sessionId.slice(0, 8)}</Text> · /help for commands
            </>
          ) : (
            "/help for commands"
          )}
        </Text>
      </Box>
    </Box>
  );
}
