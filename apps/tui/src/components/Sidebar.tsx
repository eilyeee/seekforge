/**
 * Workspace file-tree sidebar (Ctrl+E). Presentation only: the tree state
 * (nodes/expanded/cursor) lives in the app, which also routes the keys —
 * this component just windows ~20 rows around the cursor and paints them.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TreeNode } from "../file-tree.js";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";
import { listWindow } from "./Palette.js";

const MAX_ROWS = 20;
const DEFAULT_WIDTH = 28;

type SidebarProps = {
  /** Already collapse-aware (visibleNodes output). */
  visible: TreeNode[];
  cursor: number;
  /** Whether keystrokes currently go to the sidebar. */
  focused: boolean;
  width?: number;
};

export function Sidebar({ visible, cursor, focused, width }: SidebarProps): React.ReactElement {
  const { start, end } = listWindow(visible.length, cursor, MAX_ROWS);
  return (
    <Box
      flexDirection="column"
      width={width ?? DEFAULT_WIDTH}
      flexShrink={0}
      borderStyle="round"
      borderColor={focused ? ACCENT : "gray"}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      paddingX={1}
    >
      <Text color={ACCENT} bold dimColor={!focused}>
        {t("sidebar.title")}
      </Text>
      {visible.length === 0 ? <Text dimColor>{t("sidebar.empty")}</Text> : null}
      {visible.slice(start, end).map((node, i) => {
        const absolute = start + i;
        const selected = absolute === cursor;
        const indent = "  ".repeat(node.depth);
        const expanded = node.dir && nextIsChild(visible, absolute);
        const label = node.dir
          ? `${indent}${expanded ? "▾" : "▸"} ${node.name}/`
          : `${indent}  ${node.name}`;
        return (
          <Text
            key={node.path}
            inverse={selected && focused}
            color={expanded ? ACCENT : undefined}
            dimColor={!focused}
          >
            {label}
          </Text>
        );
      })}
      {end < visible.length ? <Text dimColor>… {visible.length - end} more</Text> : null}
      <Text dimColor>{t("sidebar.footer")}</Text>
    </Box>
  );
}

/** A dir is expanded iff the next visible row is one of its children. */
function nextIsChild(visible: readonly TreeNode[], index: number): boolean {
  const next = visible[index + 1];
  const node = visible[index];
  return next !== undefined && node !== undefined && next.depth > node.depth;
}
