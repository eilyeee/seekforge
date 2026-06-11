import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { summarizeArgs } from "../format.js";
import { ACCENT } from "./Header.js";

type ToolRowProps = {
  toolName: string;
  args: unknown;
  status: "running" | "ok" | "error";
  error?: { code: string; message: string };
};

export function ToolRow({ toolName, args, status, error }: ToolRowProps): React.ReactElement {
  return (
    <Box>
      <Box width={2}>
        {status === "running" ? (
          <Text color={ACCENT}>
            <Spinner type="dots" />
          </Text>
        ) : status === "ok" ? (
          <Text color="green">✓</Text>
        ) : (
          <Text color="red">✗</Text>
        )}
      </Box>
      <Text>
        <Text bold>{toolName}</Text>
        <Text dimColor> {summarizeArgs(args)}</Text>
        {status === "error" && error ? (
          <Text color="red">
            {"  "}
            {error.code}: {error.message}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
