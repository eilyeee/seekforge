import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { toolResultSummary, toolTitle } from "../render-helpers.js";
import { ACCENT } from "./Header.js";

/**
 * Claude Code-style tool row: "⏺ Read(src/app.ts)" with a spinner while
 * running, then a dim "  ⎿  120 lines" result line (red "code: message" on
 * error). When `resultPreview` is passed (verbose mode) the full preview
 * lines follow. Presentation only — no input handling.
 */
type ToolRowProps = {
  toolName: string;
  args: unknown;
  status: "running" | "ok" | "error";
  error?: { code: string; message: string };
  /** Full(ish) result payload, rendered when verbose mode (Ctrl+O) is on. */
  resultPreview?: string;
};

export function ToolRow({ toolName, args, status, error, resultPreview }: ToolRowProps): React.ReactElement {
  const { verb, detail } = toolTitle(toolName, args);
  const summary = toolResultSummary(toolName, status === "ok", resultPreview, error);
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2}>
          {status === "running" ? (
            <Text color={ACCENT}>
              <Spinner type="dots" />
            </Text>
          ) : (
            <Text color={status === "ok" ? "green" : "red"}>⏺</Text>
          )}
        </Box>
        <Text>
          <Text bold={status !== "running"}>{verb}</Text>
          {detail ? (
            <Text>
              (<Text dimColor>{detail}</Text>)
            </Text>
          ) : null}
        </Text>
      </Box>
      {status !== "running" && summary ? (
        <Text color={status === "error" ? "red" : undefined} dimColor={status !== "error"}>
          {"  ⎿  "}
          {summary}
        </Text>
      ) : null}
      {resultPreview
        ? resultPreview.split("\n").map((line, i) => (
            <Text key={i} dimColor>
              {"    "}
              {line}
            </Text>
          ))
        : null}
    </Box>
  );
}
