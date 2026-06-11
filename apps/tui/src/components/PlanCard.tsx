import React from "react";
import { Box, Text } from "ink";
import { planGlyph } from "../format.js";
import type { PlanItem } from "../model.js";
import { ACCENT } from "./Header.js";

export function PlanCard({ items }: { items: PlanItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Text color={ACCENT} bold>
        Plan
      </Text>
      {items.map((item, i) => (
        <Text key={i} color={item.status === "in_progress" ? ACCENT : undefined} dimColor={item.status === "done"}>
          {planGlyph(item.status)} {item.step}
        </Text>
      ))}
    </Box>
  );
}
