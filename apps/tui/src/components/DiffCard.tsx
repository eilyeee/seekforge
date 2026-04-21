/**
 * Collapsible colored diff card for write-tool edits: rounded gray border,
 * yellow bullet + bold path + dim add/del counts, then numbered colored diff
 * lines (add green, del red, hunk dim) with a dim right-aligned "old new"
 * gutter, capped at maxLines with a dim overflow footer. Presentation only —
 * no input handling.
 */
import React from "react";
import { Box, Text } from "ink";
import type { DiffLine, DiffLineKind } from "../model.js";
import { diffStats, numberDiffLines } from "../render-helpers.js";

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

/** Right-aligned 4-column gutter cell ("" when the side has no number). */
function gutter(n: number | undefined): string {
  return (n === undefined ? "" : String(n)).padStart(4);
}

export function DiffCard({ path, lines, maxLines = 24 }: DiffCardProps): React.ReactElement {
  const { adds, dels } = diffStats(lines);
  const numbered = numberDiffLines(lines);
  const visible = numbered.slice(0, Math.max(0, maxLines));
  const hidden = numbered.length - visible.length;
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
      {visible.map((row, i) => (
        <Text key={i}>
          {row.line.kind === "hunk" ? null : (
            <Text dimColor>
              {gutter(row.old)} {gutter(row.new)}{" "}
            </Text>
          )}
          <Text {...colorProps(row.line.kind)} dimColor={row.line.kind === "hunk"}>
            {row.line.text}
          </Text>
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>… {hidden} more lines</Text> : null}
    </Box>
  );
}
