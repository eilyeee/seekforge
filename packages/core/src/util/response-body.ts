import { ToolError } from "../tools/errors.js";

export const DEFAULT_RESPONSE_BODY_LIMIT_BYTES = 1_000_000;

/** Read a response incrementally so the size cap applies before buffering it all. */
export async function readResponseBody(
  response: Response,
  maxBytes = DEFAULT_RESPONSE_BODY_LIMIT_BYTES,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ToolError("too_large", `Response body exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ToolError("too_large", `Response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
