import { redactSecrets } from "../tools/redact.js";

export const MAX_MCP_ERROR_CHARS = 2_000;

/** Bounds and redacts any server-controlled MCP error before it reaches logs, APIs, or the model. */
export function sanitizeMcpErrorMessage(value: unknown): string {
  const text = redactSecrets(value instanceof Error ? value.message : String(value));
  if (text.length <= MAX_MCP_ERROR_CHARS) return text;
  const half = Math.floor((MAX_MCP_ERROR_CHARS - 30) / 2);
  return `${text.slice(0, half)}\n…[MCP error truncated]…\n${text.slice(-half)}`;
}

/** Error thrown for MCP transport/protocol failures (all transports). */
export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(sanitizeMcpErrorMessage(message));
    this.name = "McpError";
  }
}
