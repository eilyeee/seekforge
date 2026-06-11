import React from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "../model.js";
import { ACCENT } from "./Header.js";
import { Markdown } from "./Markdown.js";
import { ToolRow } from "./ToolRow.js";
import { PlanCard } from "./PlanCard.js";
import { ReportCard } from "./ReportCard.js";

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
    case "notice":
      return <Text color={item.tone === "error" ? "red" : undefined} dimColor={item.tone === "dim"}>{item.text}</Text>;
    case "report":
      return <ReportCard report={item.report} />;
    default:
      return null;
  }
}

export function Transcript({ items }: { items: ChatItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Item key={item.id} item={item} />
      ))}
    </Box>
  );
}
