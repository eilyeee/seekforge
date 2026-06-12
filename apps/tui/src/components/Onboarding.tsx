import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ACCENT } from "./Header.js";
import { validateApiKeyFormat } from "../onboarding.js";

type OnboardingProps = {
  onDone: (apiKey: string) => void;
  onSkip: () => void;
};

/**
 * First-run welcome card: prompts for a DeepSeek API key with a masked input.
 * Enter validates (format only) and calls onDone with the trimmed key; Esc
 * skips. Deliberate exception to the app's centralized-input rule: this
 * component owns its own useInput because it renders BEFORE the main App is
 * mounted, so there is no key-routing conflict to coordinate with.
 */
export function Onboarding({ onDone, onSkip }: OnboardingProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onSkip();
      return;
    }
    if (key.return) {
      const message = validateApiKeyFormat(value);
      if (message) {
        setError(message);
      } else {
        onDone(value.trim());
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setError(null);
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      setError(null);
      return;
    }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return;
    }
    if (input.length > 0) {
      // Paste arrives as a multi-char chunk; strip newlines/control chars.
      const clean = [...input].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("");
      if (clean.length > 0) {
        setValue((v) => v + clean);
        setError(null);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} marginY={1}>
      <Text color={ACCENT} bold>
        Welcome to SeekForge
      </Text>
      <Text dimColor>
        SeekForge needs a DeepSeek API key to talk to the model. Get one at https://platform.deepseek.com — it
        is stored locally in ~/.seekforge/config.json.
      </Text>
      <Text>
        <Text dimColor>API key: </Text>
        {"•".repeat(value.length)}
        <Text inverse> </Text>
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Paste or type your key · Enter save · Ctrl+U clear · Esc skip for now</Text>
    </Box>
  );
}
