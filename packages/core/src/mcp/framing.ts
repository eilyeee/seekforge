import type { Readable } from "node:stream";

export const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;

export type BoundedLineReader = { close(): void };

/**
 * Reads newline-delimited protocol frames without allowing an unterminated
 * frame to grow the stream's internal buffer without bound. Oversized frames
 * are discarded through their newline; the next valid frame is still parsed.
 */
export function createBoundedLineReader(
  input: Readable,
  options: {
    maxBytes?: number;
    onLine: (line: string) => void;
    onOversize: () => void;
  },
): BoundedLineReader {
  const maxBytes = options.maxBytes ?? MAX_MCP_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`line byte limit must be a positive safe integer: ${maxBytes}`);
  }
  let buffered = Buffer.alloc(0);
  let discarding = false;
  let closed = false;

  const emit = (part: Buffer): void => {
    const frame = buffered.length === 0 ? part : Buffer.concat([buffered, part], buffered.length + part.length);
    buffered = Buffer.alloc(0);
    options.onLine(frame.at(-1) === 0x0d ? frame.subarray(0, -1).toString("utf8") : frame.toString("utf8"));
  };

  const onData = (value: Buffer | string): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (discarding) {
        if (newline < 0) return;
        discarding = false;
        offset = newline + 1;
        continue;
      }
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (buffered.length + part.length > maxBytes) {
        buffered = Buffer.alloc(0);
        options.onOversize();
        if (newline < 0) {
          discarding = true;
          return;
        }
      } else if (newline >= 0) {
        emit(part);
      } else if (part.length > 0) {
        buffered = buffered.length === 0 ? Buffer.from(part) : Buffer.concat([buffered, part]);
      }
      if (newline < 0) return;
      offset = newline + 1;
    }
  };

  const onEnd = (): void => {
    if (!discarding && buffered.length > 0) emit(Buffer.alloc(0));
  };
  input.on("data", onData);
  input.on("end", onEnd);

  return {
    close(): void {
      if (closed) return;
      closed = true;
      buffered = Buffer.alloc(0);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
    },
  };
}
