import React, { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { join } from "node:path";
import {
  addMemoryFact,
  listSessions,
  loadAgentDefinitions,
  readSessionMeta,
  rewindSession,
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
          dispatch: dispatch as (a: ChatAction) => void,
          getSessionId: () => sessionIdRef.current,
          confirm: (req) =>
            new Promise<boolean>((resolve) => {
              pendingPermissionRef.current = { request: req, resolve };
              dispatch({ type: "permission", request: req });
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
      }
    },
    [projectPath, mcpToolSpecs],
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
          notice("next message starts a fresh session");
          break;
        case "sessions":
          for (const line of formatSessionLines(listSessions(projectPath))) notice(line);
          break;
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
        case "tasks":
          for (const line of formatBgTaskLines(stateRef.current.bgTasks)) notice(line);
          break;
        case "agents":
          for (const line of formatAgentLines(loadAgentDefinitions(projectPath))) notice(line);
          break;
        case "mcp":
          for (const line of formatMcpLines(config.mcpServers, mcpToolSpecs)) notice(line);
          break;
        case "context":
          dispatch({ type: "overlay", overlay: { kind: "context" } });
          break;
        case "compact":
          notice("compaction is automatic: when context usage crosses the budget, older turns");
          notice("are folded into a short digest (you'll see a 'context compacted' notice).");
          break;
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
          exit();
          break;
        case "unknown":
          notice(`unknown command ${command.raw} — /help for the list`, "error");
          break;
      }
    },
    [notice, projectPath, config.mcpServers, mcpToolSpecs, runTask, openExternalEditor, exit],
  );

  // ---------------------------------------------------------------------
  // Submit.
  // ---------------------------------------------------------------------

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
    submitTask(parsed.text);
  }, [editor.text, applyEditor, historyFile, handleSlash, submitTask]);

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
        exit();
        return;
      }
      notice("cancelling… (Ctrl+C again to force-exit)");
    } else {
      exit();
    }
  }, [exit, notice]);

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
      const count = overlay.kind === "palette" ? paletteCommands.length : pickerFiles.length;
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
        if (overlay.kind === "palette") acceptPaletteEntry(stroke.name === "return");
        else acceptFileEntry();
        return;
      }
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
        notice("cancelling… (session stays open)");
      } else if (stateRef.current.scrollOffset > 0) {
        dispatch({ type: "scroll-latest" });
      } else if (editor.text !== "") {
        applyEditor(clearAll(editor));
      }
      return;
    }

    // 6. Composer (disabled while a task runs).
    if (stateRef.current.running) return;
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
        />
        {state.overlay?.kind === "palette" ? <Palette commands={paletteCommands} index={state.overlay.index} /> : null}
        {state.overlay?.kind === "files" ? (
          <FilePicker files={pickerFiles} index={state.overlay.index} query={state.overlay.query} />
        ) : null}
        <MultilineComposer
          editor={editor}
          disabled={state.running || !!state.permission}
          placeholder="Ask SeekForge to do something…  (/ commands · @ files · # remember)"
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
