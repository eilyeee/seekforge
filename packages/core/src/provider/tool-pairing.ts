import type { ChatMessage } from "@seekforge/shared";

/**
 * Drop half-finished tool exchanges from a history before it goes on the wire.
 *
 * Every chat API enforces the same pairing: an assistant tool call must be
 * answered by a tool result, and a tool result must answer a call the model
 * actually made. A history persisted mid-turn violates that — a run cancelled
 * or errored between the assistant message and its tool results, or one that
 * hit the tool-call cap (see agent/loop.ts) — and replaying it verbatim 400s
 * the request on /resume.
 *
 * This is protocol-independent: OpenAI-compatible endpoints and the Anthropic
 * Messages API disagree on how a tool call is spelled but not on whether it has
 * to be answered, so both wire mappings normalize through here first. For a
 * well-paired live history it is a no-op.
 */
export function withPairedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const keptToolMessages = new Set<number>();
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      // Only results claimed by an assistant call above survive.
      if (!keptToolMessages.has(i) || m.toolCallId === undefined) continue;
      out.push(m);
      continue;
    }
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) {
      out.push(m);
      continue;
    }
    // Results for this turn are the run of tool messages that immediately
    // follows it; a call with no result there is unanswered.
    const resultIndexes = new Map<string, number[]>();
    for (let j = i + 1; j < messages.length && messages[j]!.role === "tool"; j++) {
      const id = messages[j]!.toolCallId;
      if (id === undefined) continue;
      const indexes = resultIndexes.get(id) ?? [];
      indexes.push(j);
      resultIndexes.set(id, indexes);
    }
    const kept = m.toolCalls.filter((c) => {
      const indexes = resultIndexes.get(c.id);
      const resultIndex = indexes?.shift();
      if (resultIndex === undefined) return false;
      keptToolMessages.add(resultIndex);
      return true;
    });
    // Spread the message and override only what this function is about. Listing
    // the fields to keep instead would silently drop every field added to
    // ChatMessage afterwards — which is exactly what happened to the images and
    // reasoning blocks a turn now carries.
    const { toolCalls: _replaced, ...rest } = m;
    out.push({ ...rest, ...(kept.length > 0 ? { toolCalls: kept } : {}) });
  }
  return out;
}
