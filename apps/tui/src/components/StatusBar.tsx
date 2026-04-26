import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { TokenUsage } from "@seekforge/shared";
import { kfmt, statusBarParts } from "../format.js";
import type { ApprovalSetting, ContextUsage } from "../model.js";
import { ACCENT } from "./Header.js";

type StatusBarProps = {
  model: string;
  context?: ContextUsage;
  usage: TokenUsage;
  running: boolean;
  approval: ApprovalSetting;
  bgRunning: number;
  scrolled: boolean;
  /** Vim composer mode; undefined when vim mode is off. */
  vim?: "insert" | "normal";
  /** Agent runs detached to the background with Ctrl+B. */
  detachedRuns?: number;
  /** Epoch ms the current run started (drives the live elapsed counter). */
  turnStartedAt?: number;
  /** Live token count this turn. */
  turnTokens?: number;
};

/** 1 Hz tick while running, so the elapsed counter advances. */
function useElapsedSeconds(startedAt: number | undefined, running: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  return startedAt !== undefined && running ? Math.floor((Date.now() - startedAt) / 1000) : 0;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const parts = statusBarParts(props);
  const elapsed = useElapsedSeconds(props.turnStartedAt, props.running);
  return (
    <Box>
      {parts.state === "working" ? (
        <Text color={ACCENT}>
          <Spinner type="dots" /> working… {elapsed > 0 ? `${elapsed}s ` : ""}
          {props.turnTokens && props.turnTokens > 0 ? `· ↓${kfmt(props.turnTokens)} tok ` : ""}
          <Text dimColor>· esc to interrupt </Text>
        </Text>
      ) : (
        <Text dimColor>ready </Text>
      )}
      <Text dimColor>
        {parts.model}
        {parts.context ? `  ·  ${parts.context}` : ""}
        {"  ·  "}
        {parts.cost}
        {"  ·  "}
        {parts.tokens}
      </Text>
      {/* approval / background / detached moved to the mode line under the
          composer (Claude Code-style); the top bar stays lean. */}
      {props.scrolled ? <Text color="yellow">{"  ·  ↑ scrolled"}</Text> : null}
      {props.vim ? (
        <Text color={props.vim === "normal" ? "magenta" : ACCENT} bold>
          {"  ·  "}
          {props.vim === "normal" ? "NORMAL" : "INSERT"}
        </Text>
      ) : null}
    </Box>
  );
}
