import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { ACCENT } from "./Header.js";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
};

export function Composer({ value, onChange, onSubmit, disabled }: ComposerProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : ACCENT} paddingX={1}>
      <Text color={ACCENT} bold>
        ❯{" "}
      </Text>
      {disabled ? (
        <Text dimColor>{value || "working… Ctrl+C to cancel"}</Text>
      ) : (
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="Ask SeekForge to do something…" />
      )}
    </Box>
  );
}
