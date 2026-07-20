// Helpers for the headless `-p/--print` mode: reading piped stdin and
// composing the final prompt from an inline argument + piped input. Pure
// functions kept here so they can be unit-tested without spawning a process.

/**
 * Composes the effective prompt from an inline prompt and piped stdin.
 *
 * Precedence (documented in README):
 *  - inline only            → inline
 *  - stdin only             → stdin (the whole prompt)
 *  - inline + stdin         → inline, then stdin under a fenced section
 *  - neither                → null (caller errors out)
 *
 * The piped input is fenced with a "--- piped input ---" marker so the model
 * can tell the instruction apart from the pasted data.
 */
export function composePrompt(inline: string | undefined, stdin: string | undefined): string | null {
  const trimmedInline = inline?.trim() ? inline : undefined;
  const trimmedStdin = stdin?.trim() ? stdin : undefined;

  if (trimmedInline && trimmedStdin) {
    return `${trimmedInline}\n\n--- piped input ---\n${trimmedStdin}`;
  }
  if (trimmedInline) return trimmedInline;
  if (trimmedStdin) return trimmedStdin;
  return null;
}

export const MAX_STDIN_PROMPT_BYTES = 16 * 1024 * 1024;

/**
 * Reads all of stdin to a string. Returns "" immediately when stdin is a TTY
 * (interactive, nothing piped) so callers never block waiting for a human.
 */
export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const finish = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_STDIN_PROMPT_BYTES) {
        cleanup();
        stream.pause();
        reject(new Error(`stdin prompt exceeds ${MAX_STDIN_PROMPT_BYTES} bytes`));
        return;
      }
      chunks.push(bytes);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}
