import { ToolError } from "./errors.js";
import { RuntimeError, type RuntimeClient } from "../runtime/index.js";

/**
 * Calls the Rust runtime and converts RuntimeError into ToolError so tools
 * surface uniform error codes regardless of execution backend.
 */
export async function callRuntime<T>(
  runtime: RuntimeClient,
  method: string,
  workspace: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  try {
    return await runtime.call<T>(method, { workspace, ...params }, opts);
  } catch (err) {
    if (err instanceof RuntimeError) {
      throw new ToolError(err.code, err.message);
    }
    throw err;
  }
}
