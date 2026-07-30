export type BoundedNewestJsonArrayOptions<T> = {
  maxItems: number;
  maxBytes: number;
  /** Wraps the array with fixed-size metadata; encoded size must shrink with a suffix. */
  envelope: (items: readonly T[]) => unknown;
  overflowMessage: string;
};

/** Serializes the newest bounded suffix while enforcing the reader's exact UTF-8 byte ceiling. */
export function serializeNewestJsonArray<T>(
  items: readonly T[],
  options: BoundedNewestJsonArrayOptions<T>,
): { retained: T[]; serialized: string } {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
    throw new RangeError("maxItems must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  let retained = items.slice(-options.maxItems);
  let serialized = `${JSON.stringify(options.envelope(retained))}\n`;
  if (retained.length > 1 && Buffer.byteLength(serialized, "utf8") > options.maxBytes) {
    let low = 1;
    let high = retained.length - 1;
    let fittingStart: number | undefined;
    let fittingSerialized: string | undefined;
    // Serialized array size decreases monotonically as the oldest prefix is
    // removed, so binary search avoids quadratic work near the byte ceiling.
    while (low <= high) {
      const start = Math.floor((low + high) / 2);
      const candidate = `${JSON.stringify(options.envelope(retained.slice(start)))}\n`;
      if (Buffer.byteLength(candidate, "utf8") <= options.maxBytes) {
        fittingStart = start;
        fittingSerialized = candidate;
        high = start - 1;
      } else {
        low = start + 1;
      }
    }
    if (fittingStart !== undefined && fittingSerialized !== undefined) {
      retained = retained.slice(fittingStart);
      serialized = fittingSerialized;
    }
  }
  if (Buffer.byteLength(serialized, "utf8") > options.maxBytes) throw new Error(options.overflowMessage);
  return { retained, serialized };
}
