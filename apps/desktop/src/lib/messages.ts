/**
 * Replays a persisted session transcript (ChatMessage[]) into ChatItems so
 * the Sessions view reuses the same renderer as live chat. Pure logic.
 */
import type { AgentEvent, ChatMessage, ToolResult } from "@seekforge/shared";
import { initialChatState, planItemsFrom, reduceEvent, type ChatItem, type NewChatItem, type PlanItem } from "./events";

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tool messages store the result serialized for the model; recover a ToolResult-ish shape. */
function parseToolResult(content: string): ToolResult {
  const parsed = tryParseJson(content);
  if (typeof parsed === "object" && parsed !== null && typeof (parsed as { ok?: unknown }).ok === "boolean") {
    return parsed as ToolResult;
  }
  return { ok: true, data: parsed !== undefined ? parsed : content };
}

export function messagesToItems(messages: ChatMessage[], events: AgentEvent[] = []): ChatItem[] {
  const resultsByCallId = new Map<string, ToolResult>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) resultsByCallId.set(m.toolCallId, parseToolResult(m.content));
  }

  const items: ChatItem[] = [];
  let nextId = 1;
  let planIdx = -1;

  const push = (item: NewChatItem) => {
    items.push({ ...item, id: nextId++ } as ChatItem);
  };
  const upsertPlan = (planItems: PlanItem[]) => {
    if (planIdx >= 0) {
      items[planIdx] = { ...(items[planIdx] as Extract<ChatItem, { kind: "plan" }>), items: planItems };
    } else {
      planIdx = items.length;
      push({ kind: "plan", items: planItems });
    }
  };

  for (const m of messages) {
    if (m.role === "user") {
      push({ kind: "user", text: m.content });
      continue;
    }
    if (m.role !== "assistant") continue; // system + tool messages have no row

    if (m.content.trim() !== "") push({ kind: "assistant", text: m.content, streaming: false });

    for (const tc of m.toolCalls ?? []) {
      const args = tryParseJson(tc.argumentsJson) ?? tc.argumentsJson;
      const result = resultsByCallId.get(tc.id);
      if (tc.name === "update_plan") {
        const plan = planItemsFrom(result?.ok ? result.data : args);
        if (plan) upsertPlan(plan);
        continue;
      }
      push({
        kind: "tool",
        name: tc.name,
        args,
        status: result ? (result.ok ? "ok" : "error") : "ok",
        result,
      });
    }
  }
  let history = { ...initialChatState(), items, nextId };
  for (const event of events) history = reduceEvent(history, event);
  return history.items;
}
