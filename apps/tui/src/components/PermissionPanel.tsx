import React from "react";
import { Box, Text } from "ink";
import type { PermissionRequest } from "@seekforge/shared";
import { classifyUnifiedDiff } from "../diff.js";
import { DiffCard } from "./DiffCard.js";

/**
 * Inline permission prompt. ALWAYS surfaces the raw command/path verbatim —
 * never only the model's paraphrase (prompt-injection defense, AGENTS.md).
 * The parent wires keypress handling; this is presentation only.
 *
 * Edit-review: when `request.preview` is present (write tools), the proposed
 * diff is rendered above the y/a/n line and the prompt becomes an explicit
 * accept/reject review. Non-preview requests keep the raw command/path display.
 */
export function PermissionPanel({ request }: { request: PermissionRequest }): React.ReactElement {
  const preview = request.preview;
  if (preview) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text color="yellow" bold>
          Review change: <Text bold>{preview.path}</Text>{" "}
          <Text dimColor>
            [{request.permission}] {request.toolName}
          </Text>
        </Text>
        <DiffCard path={preview.path} lines={classifyUnifiedDiff(preview.diff)} />
        <Text dimColor>Apply this change? y accept · n reject</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text color="yellow" bold>
        Permission required{" "}
        <Text dimColor>
          [{request.permission}] {request.toolName}
        </Text>
      </Text>
      {request.command ? (
        <Text>
          <Text dimColor>command: </Text>
          <Text bold>{request.command}</Text>
        </Text>
      ) : null}
      {request.path ? (
        <Text>
          <Text dimColor>path:    </Text>
          <Text bold>{request.path}</Text>
        </Text>
      ) : null}
      {!request.command && !request.path ? <Text>{request.description}</Text> : null}
      <Text dimColor>
        y allow once{request.command ? " · a allow similar commands this session" : ""} · any other key deny
      </Text>
    </Box>
  );
}
