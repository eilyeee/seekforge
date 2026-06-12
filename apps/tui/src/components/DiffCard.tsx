/**
 * Collapsible colored diff card for write-tool edits: rounded gray border,
 * yellow bullet + bold path + dim add/del counts, then colored diff lines
 * (add green, del red, hunk dim) capped at maxLines with a dim overflow
 * footer. Presentation only — no input handling.
 */
import React from "react";
import { Box, Text } from "ink";
import type { DiffLine, DiffLineKind } from "../model.js";

type DiffCardProps = {
  path: string;
  lines: readonly DiffLine[];
  maxLines?: number;
};

function colorProps(kind: DiffLineKind): { color?: string } {
  if (kind === "add") return { color: "green" };
  if (kind === "del") return { color: "red" };
  return {};
}

export function DiffCard({ path, lines, maxLines = 24 }: DiffCardProps): React.ReactElement {
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (line.kind === "add") adds += 1;
    else if (line.kind === "del") dels += 1;
  }
  const visible = lines.slice(0, Math.max(0, maxLines));
  const hidden = lines.length - visible.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Text>
        <Text color="yellow">● </Text>
        <Text bold>{path}</Text>
        <Text dimColor>
          {" "}
          (+{adds} −{dels})
        </Text>
      </Text>
      {visible.map((line, i) => (
        <Text key={i} {...colorProps(line.kind)} dimColor={line.kind === "hunk"}>
          {line.text}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>… {hidden} more lines</Text> : null}
    </Box>
  );
}
