import React from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "@seekforge/shared";
import { formatUsage, kfmt } from "../format.js";
import type { BgTask, ChatItem, ContextUsage } from "../model.js";
import { contextBreakdown, gauge, gaugeCaption } from "../surfaces.js";
import { ACCENT } from "./Header.js";

/**
 * The /context overlay panel: model, session id, context-window gauge,
 * a per-category breakdown (tool results vs assistant text vs diffs/shell,
 * chars/4 estimate with mini-gauges), free space until auto-compaction,
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
  /**
   * Transcript items for the per-category breakdown. Optional — without it
   * the panel renders exactly as before (single window gauge).
   */
  items?: readonly ChatItem[];
};

const MINI_GAUGE_WIDTH = 12;

export function ContextInspector({
  context,
  usage,
  itemCount,
  sessionId,
  model,
  bgTasks,
  items,
}: ContextInspectorProps): React.ReactElement {
  const runningBg = bgTasks.filter((t) => t.status === "running").length;
  const breakdown = items ? contextBreakdown(items) : [];
  const labelWidth = Math.max(0, ...breakdown.map((row) => row.label.length));
  const freeTokens = context ? Math.max(0, context.budgetTokens - context.usedTokens) : undefined;
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
      {breakdown.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>breakdown (chars/4 estimate)</Text>
          {breakdown.map((row) => (
            <Text key={row.label}>
              <Text dimColor>  {row.label.padEnd(labelWidth)}  </Text>
              {gauge(row.percent, MINI_GAUGE_WIDTH)}
              <Text dimColor>
                {"  "}~{kfmt(row.tokens)} tok · {row.count} item{row.count === 1 ? "" : "s"}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {freeTokens !== undefined && context ? (
        <Text>
          <Text dimColor>free     </Text>
          {kfmt(freeTokens)} tokens
          <Text dimColor>  until auto-compaction at {kfmt(context.budgetTokens)}</Text>
        </Text>
      ) : null}
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
