import type React from "react";
import { Box, Text } from "ink";
import { inertLine, planGlyph, planItemLabel } from "../format.js";
import type { PlanItem } from "../model.js";
import { ACCENT } from "./Header.js";

/** Longest plan label shown (core caps activeForm at 200 characters). */
const LABEL_CHARS = 200;

export function PlanCard({ items }: { items: PlanItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
      <Text color={ACCENT} bold>
        Plan
      </Text>
      {items.map((item, i) => (
        <Text key={i} color={item.status === "in_progress" ? ACCENT : undefined} dimColor={item.status === "done"}>
          {planGlyph(item.status)} {inertLine(planItemLabel(item), LABEL_CHARS)}
        </Text>
      ))}
    </Box>
  );
}
