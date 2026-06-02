import React from "react";
import { Box, Text } from "ink";
import { t } from "../strings.js";
import { ACCENT } from "./Header.js";

type QuestionPanelProps = {
  question: string;
  options: readonly string[];
  index: number;
};

/**
 * ask_user question overlay: the agent paused to ask the human something and
 * offers a short list of answers. Presentation only — the parent (App) owns
 * keypress routing and resolves the pending ask_user promise on Enter/Esc or
 * a number key, same pattern as PermissionPanel/ListOverlay.
 */
export function QuestionPanel({ question, options, index }: QuestionPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginY={1}>
      <Text color="magenta" bold>
        {t("question.title")}
      </Text>
      <Text>{question}</Text>
      {options.map((option, i) => {
        const selected = i === index;
        return (
          <Text key={i} color={selected ? ACCENT : undefined} dimColor={!selected}>
            {selected ? "❯ " : "  "}
            {i + 1}. {option}
          </Text>
        );
      })}
      <Text dimColor>
        {t("question.footerPrefix")}
        {options.length}
        {t("question.footerSuffix")}
      </Text>
    </Box>
  );
}
