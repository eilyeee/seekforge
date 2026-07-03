/**
 * Pure grouping helper for subagent (dispatch_agent) activity in the transcript.
 *
 * Nested subagent tool calls arrive as separate `step` items tagged with an
 * `agentId`. Rendered flatly they repeat the `[agentId]` prefix on every row;
 * grouping a run of consecutive same-agent steps under one header turns that
 * into a compact one-level tree (header + indented tool lines).
 *
 * This is presentation-only: the event model / reducer is unchanged. The helper
 * runs on whatever slice the transcript virtualization hands it, so grouping
 * never crosses the visible window and the raw item count still drives paging.
 */
import type { ChatItem } from "./model.js";

/** One tool call beneath a subagent header. */
export type SubagentStep = { id: string; title: string };

/**
 * A render node is either a plain chat item (rendered as before) or a subagent
 * group: a header for one `agentId` plus its consecutive tool steps.
 */
export type RenderNode =
  | { kind: "item"; item: ChatItem }
  | { kind: "subagent-group"; id: string; agentId: string; steps: SubagentStep[] };

/**
 * Collapse each maximal run of consecutive `step` items sharing an `agentId`
 * into a single `subagent-group` node. Non-subagent steps (no `agentId`) and
 * every other item pass through untouched as `item` nodes, preserving order.
 */
export function groupSubagentSteps(items: ChatItem[]): RenderNode[] {
  const out: RenderNode[] = [];
  for (const item of items) {
    if (item.kind === "step" && item.agentId) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "subagent-group" && prev.agentId === item.agentId) {
        prev.steps.push({ id: item.id, title: item.title });
        continue;
      }
      out.push({
        kind: "subagent-group",
        id: item.id,
        agentId: item.agentId,
        steps: [{ id: item.id, title: item.title }],
      });
      continue;
    }
    out.push({ kind: "item", item });
  }
  return out;
}
