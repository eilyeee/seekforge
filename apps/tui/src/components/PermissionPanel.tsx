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
 *
 * Multi-hunk: when `hunks` has length > 1 and `hunkSelection` is provided,
 * render each hunk with a togglable checkbox and let the user choose specific
 * edits. Single-hunk and no-hunk requests behave exactly as before.
 */
export function PermissionPanel({
  request,
  hunkSelection,
}: {
  request: PermissionRequest;
  hunkSelection?: number[];
}): React.ReactElement {
  const preview = request.preview;
  const hunks = request.hunks;
  const isMultiHunk = hunks && hunks.length > 1;

  // Multi-hunk edit-review: render per-hunk previews with selection checkboxes.
  if (isMultiHunk && preview) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text color="yellow" bold>
          Review change: <Text bold>{preview.path}</Text>{" "}
          <Text dimColor>
            [{request.permission}] {request.toolName}
          </Text>
        </Text>
        {hunks.map((hunk) => {
          const selected = hunkSelection?.includes(hunk.index) ?? true;
          return (
            <Box key={hunk.index} flexDirection="column">
              <Text>
                <Text color={selected ? "green" : "red"}>{selected ? "[x]" : "[ ]"}</Text>
                <Text> </Text>
                <Text bold>Hunk {hunk.index + 1}</Text>
              </Text>
              <Box paddingLeft={4}>
                <Text dimColor>{hunk.preview.slice(0, 200)}{hunk.preview.length > 200 ? "…" : ""}</Text>
              </Box>
            </Box>
          );
        })}
        <Text dimColor>
          number key toggle hunk · a select all · y confirm · n deny
        </Text>
      </Box>
    );
  }

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
