import React from "react";
import { Box, Text } from "ink";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";
import { listWindow } from "./Palette.js";

type ListOverlayProps = {
  title: string;
  lines: readonly string[];
  index: number;
  footer?: string;
};

/**
 * Generic selectable list overlay (sessions picker, future pickers). Same
 * windowed-list pattern as Palette/FilePicker; presentation only.
 */
export function ListOverlay({ title, lines, index, footer }: ListOverlayProps): React.ReactElement {
  const { start, end } = listWindow(lines.length, index, 8);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text color={ACCENT} bold>
        {title}
      </Text>
      {lines.length === 0 ? <Text dimColor>{t("picker.emptyList")}</Text> : null}
      {lines.slice(start, end).map((line, i) => {
        const absolute = start + i;
        const selected = absolute === index;
        return (
          <Text key={absolute} color={selected ? ACCENT : undefined} dimColor={!selected}>
            {selected ? "❯ " : "  "}
            {line}
          </Text>
        );
      })}
      <Text dimColor>{footer ?? t("picker.list")}</Text>
    </Box>
  );
}
