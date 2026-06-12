/**
 * Full-width transcript pager panel (Ctrl+L). Presentation only: the app owns
 * the scroll offset and routes the keys (q/Esc close, ↑↓/PgUp/PgDn/g/G);
 * this component just paints the current pagerWindow plus a position gauge.
 */

import React from "react";
import { Box, Text } from "ink";
import { pagerWindow } from "../pager-source.js";
import { ACCENT } from "./Header.js";

type PagerProps = {
  lines: readonly string[];
  /** Lines scrolled down from the top (0 = top). */
  offset: number;
  /** Visible body height in rows. */
  height: number;
};

export function Pager({ lines, offset, height }: PagerProps): React.ReactElement {
  const win = pagerWindow(lines, offset, height);
  const maxOffset = Math.max(0, lines.length - Math.max(0, height));
  const percent = maxOffset === 0 ? 100 : Math.round((win.hiddenAbove / maxOffset) * 100);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={ACCENT} bold>
          Transcript <Text dimColor>(q/Esc close · ↑↓/PgUp/PgDn/g/G scroll)</Text>
        </Text>
        <Text dimColor>{percent}%</Text>
      </Box>
      {lines.length === 0 ? <Text dimColor>(transcript is empty)</Text> : null}
      {lines.slice(win.start, win.end).map((line, i) => (
        <Text key={win.start + i} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}
