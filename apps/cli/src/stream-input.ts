// Pure parser for Claude-Code-style `--input-format stream-json` INPUT.
//
// The input is line-delimited JSON on a readable stream: each line is a
// message envelope. We yield the plain text of every *user* turn so a caller
// can drive a multi-turn headless session. Non-user envelopes (system,
// assistant, result, ...) are echoed by some tools and are ignored.

/** Accepted shapes of a content block inside a user message. */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/** The inner `message` of a user envelope (SDK / content-as-string forms). */
interface UserMessage {
  role?: unknown;
  content?: unknown;
}

/** A line envelope. Only `type === "user"` lines produce output. */
interface Envelope {
  type?: unknown;
  text?: unknown;
  message?: unknown;
}

/** Build the standard "invalid JSON" error for line `lineNo` (1-based). */
function invalidJson(lineNo: number, line: string): Error {
  return new Error(
    `stream-json input: invalid JSON on line ${lineNo}: ${snippet(line)}`,
  );
}

/** Build the "no extractable text" error for line `lineNo` (1-based). */
function noText(lineNo: number, line: string): Error {
  return new Error(
    `stream-json input: no extractable text in user envelope on line ${lineNo}: ${snippet(line)}`,
  );
}

/** A short, single-line snippet of an offending line for error messages. */
function snippet(line: string): string {
  const oneLine = line.replace(/\s+/g, " ").trim();
  const max = 80;
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Extract the user text from a parsed envelope, or `null` if the envelope is
 * not a user turn (and should therefore be skipped silently).
 *
 * Returns the empty string for a user envelope that has no extractable text;
 * the caller turns that into a thrown error (empty user text is invalid).
 */
function extractUserText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const env = value as Envelope;
  if (env.type !== "user") return null;

  // Simple form: { type: "user", text: "hello" }
  if (typeof env.text === "string") return env.text;

  const message = env.message;
  if (typeof message === "object" && message !== null) {
    const msg = message as UserMessage;

    // Content-as-string form: { message: { content: "hello" } }
    if (typeof msg.content === "string") return msg.content;

    // SDK form: { message: { content: [{ type: "text", text: "..." }] } }
    if (Array.isArray(msg.content)) {
      let out = "";
      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as ContentBlock;
        if (b.type === "text" && typeof b.text === "string") out += b.text;
      }
      return out;
    }
  }

  // A user envelope, but nothing we can read out of it.
  return "";
}

/**
 * Yields the text of each user turn parsed from a Claude-style stream-json
 * input stream.
 */
export async function* readStreamJsonInput(
  stream: NodeJS.ReadableStream,
): AsyncIterable<string> {
  stream.setEncoding("utf8");

  let buffer = "";
  let lineNo = 0;

  // Parse one complete (newline-terminated) line. Returns the text to yield,
  // or null if the line is blank or a non-user envelope (skip silently).
  function handleLine(rawLine: string): string | null {
    // A trailing \r (CRLF input) is whitespace and is harmless; trimming for
    // the blank check and JSON.parse both tolerate it.
    if (rawLine.trim() === "") return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      throw invalidJson(lineNo, rawLine);
    }

    const text = extractUserText(parsed);
    if (text === null) return null; // non-user envelope
    if (text === "") throw noText(lineNo, rawLine);
    return text;
  }

  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      lineNo++;
      const text = handleLine(rawLine);
      if (text !== null) yield text;
    }
  }

  // Flush any trailing line not terminated by a newline.
  if (buffer.length > 0) {
    lineNo++;
    const text = handleLine(buffer);
    if (text !== null) yield text;
  }
}
