import React from "react";
import { Box, Text } from "ink";
import type { PermissionRequest } from "@seekforge/shared";

/**
 * Inline permission prompt. ALWAYS surfaces the raw command/path verbatim —
 * never only the model's paraphrase (prompt-injection defense, AGENTS.md).
 * The parent wires keypress handling; this is presentation only.
 */
export function PermissionPanel({ request }: { request: PermissionRequest }): React.ReactElement {
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
      <Text dimColor>Allow? press y to approve, any other key to deny</Text>
    </Box>
  );
}
