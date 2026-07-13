/**
 * Presentation-only multiline composer: renders an EditorState (buffer +
 * cursor) inside the rounded input box. No useInput here — key routing is
 * centralized in app.tsx, which owns the editor state and pushes it down.
 */

import React from "react";
import { Box, Text } from "ink";
import { snapToBoundary, type EditorState } from "../editor.js";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";

type MultilineComposerProps = {
  editor: EditorState;
  disabled: boolean;
  placeholder?: string;
  /** History-based ghost completion shown dim after the cursor (→ accepts). */
  ghost?: string;
};

/** A buffer line with the cursor rendered as an inverse character. */
export function splitLineAtCursor(line: string, column: number): { before: string; at: string; after: string } {
  const safeColumn = snapToBoundary(line, Math.max(0, Math.min(column, line.length)));
  if (safeColumn >= line.length) return { before: line, at: " ", after: "" };
  const codePoint = line.codePointAt(safeColumn)!;
  const at = String.fromCodePoint(codePoint);
  return {
    before: line.slice(0, safeColumn),
    at,
    after: line.slice(safeColumn + at.length),
  };
}

function LineWithCursor({ line, column, ghost }: { line: string; column: number; ghost?: string }): React.ReactElement {
  const { before, at, after } = splitLineAtCursor(line, column);
  const atEnd = after === "" && before === line;
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {atEnd && ghost ? <Text dimColor>{ghost}</Text> : null}
      {after}
    </Text>
  );
}

export function MultilineComposer({
  editor,
  disabled,
  placeholder,
  ghost,
}: MultilineComposerProps): React.ReactElement {
  if (disabled) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={ACCENT} bold>
          ❯{" "}
        </Text>
        <Text dimColor>{t("composer.permissionWait")}</Text>
      </Box>
    );
  }

  if (editor.text === "") {
    return (
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Text color={ACCENT} bold>
          ❯{" "}
        </Text>
        <Text>
          <Text inverse> </Text>
          <Text dimColor>{placeholder ?? "Ask SeekForge to do something…"}</Text>
        </Text>
      </Box>
    );
  }

  const lines = editor.text.split("\n");
  const beforeCursor = editor.text.slice(0, editor.cursor);
  const cursorLine = beforeCursor.split("\n").length - 1;
  const cursorColumn = editor.cursor - (beforeCursor.lastIndexOf("\n") + 1);

  return (
    <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          {i === 0 ? (
            <Text color={ACCENT} bold>
              ❯{" "}
            </Text>
          ) : (
            <Text dimColor>… </Text>
          )}
          {i === cursorLine ? <LineWithCursor line={line} column={cursorColumn} {...(ghost ? { ghost } : {})} /> : <Text>{line}</Text>}
        </Box>
      ))}
    </Box>
  );
}
