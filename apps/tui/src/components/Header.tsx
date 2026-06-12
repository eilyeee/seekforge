import React from "react";
import { Box, Text } from "ink";
import { pickTip } from "../render-helpers.js";
import { t } from "../strings.js";

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

/**
 * Welcome banner, CodeWhale-style density: one accent title row
 * "◆ SeekForge v0.7.0 · <model>" inside the box, the project path dim on the
 * second line, and the rotating tip below the box.
 */
export function Header({ projectPath, model, version }: HeaderProps): React.ReactElement {
  // Pick one tip per mount so re-renders don't shuffle it.
  const tip = React.useMemo(() => pickTip(), []);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={ACCENT} paddingX={1} flexDirection="column">
        <Text>
          <Text color={ACCENT} bold>
            ◆ SeekForge{version ? ` v${version}` : ""}
          </Text>
          <Text dimColor> · {model}</Text>
        </Text>
        <Text dimColor>{projectPath}</Text>
      </Box>
      <Text dimColor>
        {"  "}
        {t("tip.prefix")} {tip}
      </Text>
    </Box>
  );
}
