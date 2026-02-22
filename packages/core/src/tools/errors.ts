/** Structured error that built-in tools throw; the dispatcher maps it to ToolResult.error. */
export class ToolError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}
