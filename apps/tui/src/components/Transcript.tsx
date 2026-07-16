import React from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "../model.js";
import { groupSubagentSteps, type RenderNode } from "../subagent-group.js";
import { computeWindow } from "../viewport.js";
import { ACCENT } from "./Header.js";
import { Markdown } from "./Markdown.js";
import { ToolRow } from "./ToolRow.js";
import { PlanCard } from "./PlanCard.js";
import { ReportCard } from "./ReportCard.js";
import { DiffCard } from "./DiffCard.js";

function Item({ item, verbose }: { item: ChatItem; verbose: boolean }): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={ACCENT} bold>
            ❯{" "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Markdown text={item.text} />
        </Box>
      );
    case "thinking": {
      // Streaming: show the tail. Done: a one-line summary; verbose expands.
      if (item.streaming) {
        const tail = item.text.trimEnd().split("\n").slice(-3);
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color="magenta" dimColor>
              ✻ thinking…
            </Text>
            {tail.map((l, i) => (
              <Text key={i} dimColor italic>
                {"  "}
                {l}
              </Text>
            ))}
          </Box>
        );
      }
      const secs = item.endedAt ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000)) : 0;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta" dimColor>
            ✻ thought{secs > 0 ? ` for ${secs}s` : ""}
            {!verbose ? <Text dimColor> (Ctrl+O to expand)</Text> : null}
          </Text>
          {verbose
            ? item.text
                .trimEnd()
                .split("\n")
                .map((l, i) => (
                  <Text key={i} dimColor italic>
                    {"  "}
                    {l}
                  </Text>
                ))
            : null}
        </Box>
      );
    }
    case "step":
      // Subagent steps (agentId) are grouped into a SubagentGroup upstream; a
      // stray one still renders as an indented branch row here.
      if (item.agentId) {
        return (
          <Text dimColor>
            {"  ↳ "}
            <Text color={ACCENT}>[{item.agentId}]</Text> {item.title}
          </Text>
        );
      }
      return <Text dimColor>· {item.title}</Text>;
    case "subagent": {
      const color = item.status === "done" ? "green" : item.status === "running" ? "yellow" : "red";
      const shownSteps = verbose ? item.steps : item.steps.slice(-8);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={color}>●</Text>{" "}
            <Text color={ACCENT} bold>
              [{item.dispatchId}] {item.agentId}
            </Text>{" "}
            <Text color={color}>{item.status}</Text>
          </Text>
          <Text dimColor>
            {"  "}
            {item.task}
          </Text>
          {item.subSessionId ? (
            <Text dimColor>
              {"  session "}
              {item.subSessionId}
            </Text>
          ) : null}
          {shownSteps.map((step, index) => (
            <Text key={`${index}-${step}`} dimColor>
              {"    • "}
              {step}
            </Text>
          ))}
          {!verbose && item.steps.length > shownSteps.length ? (
            <Text dimColor>
              {"    … "}
              {item.steps.length - shownSteps.length} earlier steps
            </Text>
          ) : null}
          {item.resultSummary ? (
            <Text color={item.status === "done" ? undefined : "red"}>
              {"  "}
              {item.resultSummary}
            </Text>
          ) : null}
        </Box>
      );
    }
    case "tool":
      return (
        <ToolRow
          toolName={item.toolName}
          args={item.args}
          status={item.status}
          error={item.error}
          {...(item.resultPreview ? { resultPreview: item.resultPreview } : {})}
          {...(item.outputTail ? { outputTail: item.outputTail } : {})}
          verbose={verbose}
        />
      );
    case "plan":
      return <PlanCard items={item.items} />;
    case "file":
      return (
        <Text>
          <Text color="yellow">● changed </Text>
          {item.path}
        </Text>
      );
    case "diff":
      return (
        <DiffCard path={item.path} lines={item.lines} {...(verbose ? { maxLines: Number.MAX_SAFE_INTEGER } : {})} />
      );
    case "shell": {
      const lines = item.output.trimEnd().split("\n");
      const shown = verbose ? lines : lines.slice(0, 30);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={item.exitCode === 0 ? "green" : "red"} bold>
              ${" "}
            </Text>
            <Text bold>{item.command}</Text>
            {item.exitCode !== 0 ? <Text color="red"> (exit {item.exitCode})</Text> : null}
          </Text>
          {shown.map((l, i) => (
            <Text key={i} dimColor>
              {"  "}
              {l}
            </Text>
          ))}
          {lines.length > shown.length ? <Text dimColor> … {lines.length - shown.length} more lines</Text> : null}
        </Box>
      );
    }
    case "notice":
      return (
        <Text color={item.tone === "error" ? "red" : undefined} dimColor={item.tone === "dim"}>
          {item.text}
        </Text>
      );
    case "report":
      return <ReportCard report={item.report} />;
    default:
      return null;
  }
}

/**
 * Memoized item renderer: ChatItems are immutable (the reducer replaces only
 * the items it changes), so settled transcript entries skip re-rendering —
 * and re-parsing markdown / re-highlighting code — on every streamed delta.
 * This is the main defense against flicker during long runs.
 */
const MemoItem = React.memo(Item);

/**
 * A run of consecutive subagent steps rendered as a one-level tree: an
 * `↳ [agentId]` header with each tool call listed one indent deeper.
 */
function SubagentGroup({ group }: { group: Extract<RenderNode, { kind: "subagent-group" }> }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {"  ↳ "}
        <Text color={ACCENT}>[{group.agentId}]</Text>
      </Text>
      {group.steps.map((s) => (
        <Text key={s.id} dimColor>
          {"      • "}
          {s.title}
        </Text>
      ))}
    </Box>
  );
}

const MemoSubagentGroup = React.memo(SubagentGroup);

type TranscriptProps = {
  items: ChatItem[];
  /** Items hidden below the viewport (0 = pinned to latest). */
  offset: number;
  /** Max items rendered at once (older ones are virtualized away). */
  size: number;
  /** Ctrl+O: render full tool results / diffs / shell output. */
  verbose: boolean;
};

export function Transcript({ items, offset, size, verbose }: TranscriptProps): React.ReactElement {
  const { start, end, hiddenAbove, hiddenBelow } = computeWindow(items.length, offset, size);
  const nodes = groupSubagentSteps(items.slice(start, end));
  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? <Text dimColor>… {hiddenAbove} earlier items (PageUp to scroll)</Text> : null}
      {nodes.map((node) =>
        node.kind === "subagent-group" ? (
          <MemoSubagentGroup key={node.id} group={node} />
        ) : (
          <MemoItem key={node.item.id} item={node.item} verbose={verbose} />
        ),
      )}
      {hiddenBelow > 0 ? (
        <Text dimColor>
          ↓ {hiddenBelow} newer items <Text color={ACCENT}>(Esc jumps to latest)</Text>
        </Text>
      ) : null}
    </Box>
  );
}
