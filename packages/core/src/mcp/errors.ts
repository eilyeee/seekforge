/** Error thrown for MCP transport/protocol failures (all transports). */
export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}
