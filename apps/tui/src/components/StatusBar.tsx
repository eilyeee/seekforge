import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { TokenUsage } from "@seekforge/shared";
import { statusBarParts } from "../format.js";
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
};

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const parts = statusBarParts(props);
  return (
    <Box>
      {parts.state === "working" ? (
        <Text color={ACCENT}>
          <Spinner type="dots" /> working…{" "}
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
      {parts.approval ? (
        <Text color={props.approval === "auto" ? "yellow" : "magenta"}>
          {"  ·  "}
          {parts.approval}
        </Text>
      ) : null}
      {parts.bg ? (
        <Text color={ACCENT}>
          {"  ·  "}
          {parts.bg}
        </Text>
      ) : null}
      {props.detachedRuns && props.detachedRuns > 0 ? (
        <Text color="yellow">{`  ·  ⚒ ${props.detachedRuns} run${props.detachedRuns > 1 ? "s" : ""} bg`}</Text>
      ) : null}
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
