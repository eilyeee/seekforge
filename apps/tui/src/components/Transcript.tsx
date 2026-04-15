import React from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "../model.js";
import { computeWindow } from "../viewport.js";
import { ACCENT } from "./Header.js";
import { Markdown } from "./Markdown.js";
import { ToolRow } from "./ToolRow.js";
import { PlanCard } from "./PlanCard.js";
import { ReportCard } from "./ReportCard.js";
import { DiffCard } from "./DiffCard.js";

function Item({ item }: { item: ChatItem }): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>
            ❯{" "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Markdown text={item.text} />
        </Box>
      );
    case "step":
      // Nested subagent activity renders as an indented branch row.
      if (item.agentId) {
        return (
          <Text dimColor>
            {"  ↳ "}
            <Text color={ACCENT}>[{item.agentId}]</Text> {item.title}
          </Text>
        );
      }
      return <Text dimColor>· {item.title}</Text>;
    case "tool":
      return <ToolRow toolName={item.toolName} args={item.args} status={item.status} error={item.error} />;
    case "plan":
      return <PlanCard items={item.items} />;
    case "file":
      return (
        <Text>
          <Text color="yellow">● changed </Text>
          {item.path}
        </Text>
      );
    case "diff":
      return <DiffCard path={item.path} lines={item.lines} />;
    case "notice":
      return <Text color={item.tone === "error" ? "red" : undefined} dimColor={item.tone === "dim"}>{item.text}</Text>;
    case "report":
      return <ReportCard report={item.report} />;
    default:
      return null;
  }
}

type TranscriptProps = {
  items: ChatItem[];
  /** Items hidden below the viewport (0 = pinned to latest). */
  offset: number;
  /** Max items rendered at once (older ones are virtualized away). */
  size: number;
};

export function Transcript({ items, offset, size }: TranscriptProps): React.ReactElement {
  const { start, end, hiddenAbove, hiddenBelow } = computeWindow(items.length, offset, size);
  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? <Text dimColor>… {hiddenAbove} earlier items (PageUp to scroll)</Text> : null}
      {items.slice(start, end).map((item) => (
        <Item key={item.id} item={item} />
      ))}
      {hiddenBelow > 0 ? (
        <Text dimColor>
          ↓ {hiddenBelow} newer items <Text color={ACCENT}>(Esc jumps to latest)</Text>
        </Text>
      ) : null}
    </Box>
  );
}
