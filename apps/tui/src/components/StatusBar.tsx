import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { TokenUsage } from "@seekforge/shared";
import { statusBarParts } from "../format.js";
import type { ContextUsage } from "../model.js";
import { ACCENT } from "./Header.js";

type StatusBarProps = {
  model: string;
  context?: ContextUsage;
  usage: TokenUsage;
  running: boolean;
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
    </Box>
  );
}
