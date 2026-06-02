/**
 * Presentation-only slash-command palette overlay. The list arrives already
 * fuzzy-filtered (app.tsx + fuzzy.ts) and the selection index lives in the
 * reducer's overlay state — this component only windows and paints rows.
 */

import React from "react";
import { Box, Text } from "ink";
import type { CommandSpec } from "../commands.js";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";

const MAX_VISIBLE = 8;

/** Window of `size` rows keeping `index` visible, clamped to the list. */
export function listWindow(count: number, index: number, size: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
  return { start, end: Math.min(count, start + size) };
}

export function Palette({
  commands,
  index,
}: {
  commands: ReadonlyArray<CommandSpec>;
  index: number;
}): React.ReactElement {
  const { start, end } = listWindow(commands.length, index, MAX_VISIBLE);
  const visible = commands.slice(start, end);

  return (
    <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
      {visible.length === 0 ? (
        <Text dimColor>{t("picker.emptyCommands")}</Text>
      ) : (
        visible.map((cmd, i) => {
          const selected = start + i === index;
          return (
            <Box key={cmd.name}>
              {selected ? <Text color={ACCENT}>❯ </Text> : <Text>{"  "}</Text>}
              <Text bold={selected}>/{cmd.name}</Text>
              {cmd.args ? <Text dimColor> {cmd.args}</Text> : null}
              <Text dimColor>{"  "}{cmd.summary}</Text>
            </Box>
          );
        })
      )}
      <Text dimColor>{t("picker.palette")}</Text>
    </Box>
  );
}
