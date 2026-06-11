import React from "react";
import { Box, Text } from "ink";

export const ACCENT = "cyan";

export function Header({ projectPath, model }: { projectPath: string; model: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
        <Text>
          <Text color={ACCENT} bold>
            SeekForge
          </Text>
          <Text dimColor> · a local-first coding agent powered by DeepSeek</Text>
        </Text>
        <Text dimColor>
          {projectPath}  ·  {model}
        </Text>
      </Box>
      <Text dimColor>  Type a task, or /help for commands. Ctrl+C cancels, twice exits.</Text>
    </Box>
  );
}
