import React from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "@seekforge/shared";
import { formatUsage } from "../format.js";
import type { BgTask, ContextUsage } from "../model.js";
import { gauge, gaugeCaption } from "../surfaces.js";
import { ACCENT } from "./Header.js";

/**
 * The /context overlay panel: model, session id, context-window gauge,
 * cumulative usage, transcript size, and running background tasks.
 * Presentation only — the app routes Esc to close via the overlay stack.
 */
export type ContextInspectorProps = {
  /** Latest context-window occupancy; undefined until a turn has run. */
  context?: ContextUsage;
  /** Cumulative session usage (cost + tokens). */
  usage: TokenUsage;
  /** Transcript length (number of chat items). */
  itemCount: number;
  sessionId?: string;
  model: string;
  bgTasks: readonly BgTask[];
};

export function ContextInspector({
  context,
  usage,
  itemCount,
  sessionId,
  model,
  bgTasks,
}: ContextInspectorProps): React.ReactElement {
  const runningBg = bgTasks.filter((t) => t.status === "running").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginY={1}>
      <Text color={ACCENT} bold>
        Context
      </Text>
      <Text>
        <Text dimColor>model    </Text>
        {model}
      </Text>
      <Text>
        <Text dimColor>session  </Text>
        {sessionId ?? "(new)"}
      </Text>
      {context ? (
        <Text>
          <Text dimColor>window   </Text>
          {gauge(context.percent)}
          <Text dimColor>  {gaugeCaption(context.usedTokens, context.budgetTokens)}</Text>
        </Text>
      ) : (
        <Text>
          <Text dimColor>window   no turn run yet</Text>
        </Text>
      )}
      <Text>
        <Text dimColor>usage    </Text>
        {formatUsage(usage)}
      </Text>
      <Text>
        <Text dimColor>items    </Text>
        {itemCount} transcript item{itemCount === 1 ? "" : "s"}
      </Text>
      {runningBg > 0 ? (
        <Text>
          <Text dimColor>tasks    </Text>⚙ {runningBg} background task{runningBg === 1 ? "" : "s"} running
        </Text>
      ) : null}
      <Text dimColor>older turns auto-compact past the budget · Esc to close</Text>
    </Box>
  );
}
