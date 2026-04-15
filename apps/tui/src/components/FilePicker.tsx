/**
 * Presentation-only @ file picker overlay. Files arrive already ranked
 * (files.ts rankFiles: fuzzy + frecency) and the selection index lives in
 * the reducer's overlay state — this component only windows and paints.
 */

import React from "react";
import { Box, Text } from "ink";
import { ACCENT } from "./Header.js";
import { listWindow } from "./Palette.js";

const MAX_VISIBLE = 8;

export function FilePicker({
  files,
  index,
  query,
}: {
  files: readonly string[];
  index: number;
  query: string;
}): React.ReactElement {
  const { start, end } = listWindow(files.length, index, MAX_VISIBLE);
  const visible = files.slice(start, end);

  return (
    <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
      <Text dimColor>@{query}</Text>
      {visible.length === 0 ? (
        <Text dimColor>no matching files</Text>
      ) : (
        visible.map((file, i) => {
          const selected = start + i === index;
          return (
            <Box key={file}>
              {selected ? <Text color={ACCENT}>❯ </Text> : <Text>{"  "}</Text>}
              <Text bold={selected}>{file}</Text>
            </Box>
          );
        })
      )}
      <Text dimColor>↑↓ select · Tab/Enter complete · Esc dismiss</Text>
    </Box>
  );
}
