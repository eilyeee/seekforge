import React from "react";
import { Box, Text } from "ink";
import { pickTip } from "../render-helpers.js";

/**
 * Accent color, set once at startup from the theme (live ESM binding: every
 * component imports ACCENT and reads the current value at render time).
 */
export let ACCENT = "cyan";

export function setAccent(color: string): void {
  ACCENT = color;
}

type HeaderProps = {
  projectPath: string;
  model: string;
  /** TUI package version, shown as "SeekForge v0.7.0" when provided. */
  version?: string;
};

export function Header({ projectPath, model, version }: HeaderProps): React.ReactElement {
  // Pick one tip per mount so re-renders don't shuffle it.
  const tip = React.useMemo(() => pickTip(), []);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
        <Text>
          <Text color={ACCENT} bold>
            SeekForge{version ? ` v${version}` : ""}
          </Text>
          <Text dimColor> · a local-first coding agent powered by DeepSeek</Text>
        </Text>
        <Text dimColor>
          {projectPath}  ·  {model}
        </Text>
      </Box>
      <Text dimColor>  ※ {tip}</Text>
    </Box>
  );
}
