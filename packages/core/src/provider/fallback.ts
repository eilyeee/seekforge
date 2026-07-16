/**
 * Fallback text protocol for tool calling, used when native tool calling is
 * unreliable. The model is instructed (via buildFallbackToolPrompt) to emit:
 *
 *   ```tool_call
 *   {"name": "read_file", "arguments": {"path": "src/App.tsx"}}
 *   ```
 */

import type { ProviderToolCall, ToolDefinitionForModel } from "@seekforge/shared";

const TOOL_CALL_BLOCK_RE = /```[ \t]*tool_call[ \t]*\r?\n([\s\S]*?)```/g;

/** Parse fenced tool_call blocks out of free text. Malformed blocks are ignored. */
export function parseFallbackToolCalls(text: string): ProviderToolCall[] {
  const calls: ProviderToolCall[] = [];
  for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    const raw = (match[1] ?? "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { name?: unknown }).name !== "string") {
      continue;
    }
    const { name, arguments: args } = parsed as { name: string; arguments?: unknown };
    calls.push({
      id: `fallback-${calls.length + 1}`,
      name,
      argumentsJson: JSON.stringify(args ?? {}),
    });
  }
  return calls;
}

/**
 * Render tool documentation plus the tool_call block format instructions,
 * for injection into a system prompt.
 */
export function buildFallbackToolPrompt(tools: ToolDefinitionForModel[]): string {
  const toolDocs = tools
    .map((t) => `### ${t.name}\n${t.description}\nParameters (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join("\n\n");
  return [
    "## Tool calling",
    "",
    "You have access to the tools listed below. To call a tool, output a fenced",
    "code block with the language tag `tool_call` containing a single JSON object:",
    "",
    "```tool_call",
    '{"name": "<tool_name>", "arguments": { <parameters> }}',
    "```",
    "",
    "Rules:",
    "- Exactly one JSON object per block; emit one block per tool call.",
    "- `arguments` must be a JSON object matching the tool's parameter schema.",
    "- Output nothing else on the lines of the block.",
    "- If no tool is needed, answer normally without any tool_call block.",
    "",
    "## Available tools",
    "",
    toolDocs,
  ].join("\n");
}
