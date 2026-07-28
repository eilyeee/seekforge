import type { ToolResult } from "@seekforge/shared";
import { truncateHeadTail } from "../tools/index.js";

/** Serializes one untrusted tool result into a bounded model-facing envelope. */
export function toolResultForModel(result: ToolResult, maxChars: number): string {
  const payload = result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) return serialized;
  const fit = (render: (preview: string) => string): string => {
    let low = 0;
    let high = serialized.length;
    let best = render("");
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = render(truncateHeadTail(serialized, middle).text);
      if (candidate.length <= maxChars) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  };
  if (result.ok) return fit((preview) => JSON.stringify({ ok: true, data: { truncated: true, preview } }));
  return fit((message) =>
    JSON.stringify({
      ok: false,
      error: { code: (result.error?.code ?? "tool_error").slice(0, 40), message, truncated: true },
    }),
  );
}
