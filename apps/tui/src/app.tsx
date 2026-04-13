import React, { useCallback, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ToolSpec } from "@seekforge/core";
import type { PermissionRequest } from "@seekforge/shared";
import type { TuiConfig } from "./config.js";
import { chatReducer, initialState, type ChatAction } from "./model.js";
import { formatUsage, kfmt } from "./format.js";
import { parseInput, HELP_LINES, type SlashCommand } from "./commands.js";
import { runSession } from "./agent/run-session.js";
import { Header } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { StatusBar } from "./components/StatusBar.js";
import { Composer } from "./components/Composer.js";
import { PermissionPanel } from "./components/PermissionPanel.js";
import { ACCENT } from "./components/Header.js";

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

export function App({ config, projectPath, initialModel, mcpToolSpecs }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialState(initialModel));
  const [input, setInput] = useState("");

  // Mutable refs hold values the async run loop reads after renders.
  const sessionIdRef = useRef<string | undefined>(undefined);
  sessionIdRef.current = state.sessionId;
  const modelRef = useRef(state.model);
  modelRef.current = state.model;

  const controllerRef = useRef<AbortController | null>(null);
  const pendingPermissionRef = useRef<PendingPermission | null>(null);
  const sigintCountRef = useRef(0);

  const showHelp = useCallback(() => {
    dispatch({ type: "notice", text: "Slash commands:" });
    for (const [cmd, desc] of HELP_LINES) {
      dispatch({ type: "notice", text: `  ${cmd.padEnd(16)} ${desc}` });
    }
    dispatch({ type: "notice", text: "  @path tokens inline file contents." });
  }, []);

  const runTask = useCallback(
    async (task: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      sigintCountRef.current = 0;
      dispatch({ type: "user", text: task });
      dispatch({ type: "run-start" });
      try {
        await runSession(task, controller.signal, {
          config,
          model: modelRef.current,
          projectPath,
          mcpToolSpecs,
          dispatch: dispatch as (a: ChatAction) => void,
          getSessionId: () => sessionIdRef.current,
          confirm: (req) =>
            new Promise<boolean>((resolve) => {
              pendingPermissionRef.current = { request: req, resolve };
              dispatch({ type: "permission", request: req });
            }),
        });
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
    [config, projectPath, mcpToolSpecs],
  );

  const handleSlash = useCallback(
    (command: SlashCommand) => {
      switch (command.name) {
        case "help":
          showHelp();
          break;
        case "new":
          dispatch({ type: "new-session" });
          dispatch({ type: "notice", text: "next message starts a fresh session" });
          break;
        case "model":
          if (!command.arg) {
            dispatch({ type: "notice", text: `model: ${modelRef.current}` });
          } else if (command.arg === "deepseek-reasoner") {
            dispatch({ type: "notice", tone: "error", text: "deepseek-reasoner has no tool calling and cannot drive the agent" });
          } else {
            dispatch({ type: "set-model", model: command.arg });
            dispatch({ type: "notice", text: `model: ${command.arg}` });
          }
          break;
        case "context":
          if (state.context) {
            const { usedTokens, budgetTokens, percent } = state.context;
            dispatch({ type: "notice", text: `context: ${kfmt(usedTokens)} of ${kfmt(budgetTokens)} budget tokens used (${percent}%)` });
          } else {
            dispatch({ type: "notice", text: "context: no turn run yet" });
          }
          break;
        case "usage":
          dispatch({ type: "notice", text: formatUsage(state.totalUsage) });
          break;
        case "quit":
          exit();
          break;
        case "unknown":
          dispatch({ type: "notice", tone: "error", text: `unknown command ${command.raw} — /help for the list` });
          break;
      }
    },
    [showHelp, state.context, state.totalUsage, exit],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      const parsed = parseInput(raw);
      setInput("");
      if (parsed.kind === "empty") return;
      if (parsed.kind === "slash") {
        handleSlash(parsed.command);
        return;
      }
      void runTask(parsed.text);
    },
    [handleSlash, runTask],
  );

  // Global key handling: permission y/n, and Ctrl+C cancel/exit.
  useInput((inputKey, key) => {
    if (pendingPermissionRef.current) {
      const approved = inputKey.toLowerCase() === "y";
      const pending = pendingPermissionRef.current;
      pendingPermissionRef.current = null;
      dispatch({ type: "permission-resolved" });
      pending.resolve(approved);
      return;
    }
    if (key.ctrl && inputKey === "c") {
      if (controllerRef.current) {
        sigintCountRef.current += 1;
        if (sigintCountRef.current >= 2) {
          controllerRef.current.abort();
          exit();
          return;
        }
        controllerRef.current.abort();
        dispatch({ type: "notice", tone: "dim", text: "cancelling… (Ctrl+C again to force-exit)" });
      } else {
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Header projectPath={projectPath} model={state.model} />
      <Transcript items={state.items} />
      {state.permission ? <PermissionPanel request={state.permission} /> : null}
      <Box flexDirection="column" marginTop={1}>
        <StatusBar model={state.model} context={state.context} usage={state.totalUsage} running={state.running} />
        <Composer value={input} onChange={setInput} onSubmit={handleSubmit} disabled={state.running || !!state.permission} />
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
