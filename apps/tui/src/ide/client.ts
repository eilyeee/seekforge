/**
 * HTTP client for the IDE bridge (the VS Code extension's side of `/ide`).
 *
 * Loopback only, bearer token per request, a deadline on every call, and a
 * response-size cap enforced while reading. Everything the IDE returns is
 * validated field by field and anything off-contract is dropped: the IDE is a
 * local process, not a trusted one, and its answers end up in prompts.
 */

import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";

export const IDE_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OPEN_FILES = 200;
const MAX_DIAGNOSTICS = 500;
const MAX_SELECTION_CHARS = 256 * 1024;
const MAX_MESSAGE_CHARS = 2_000;

export type IdeSeverity = "error" | "warning" | "info" | "hint";

export type IdeDiagnostic = {
  path: string;
  line: number;
  column: number;
  severity: IdeSeverity;
  message: string;
  source?: string;
};

export type IdeSelection = { path: string; startLine: number; endLine: number; text: string };

export type IdeContext = {
  activeFile?: string;
  selection?: IdeSelection;
  openFiles: string[];
  diagnostics: IdeDiagnostic[];
};

export type IdeClient = {
  getContext(signal?: AbortSignal): Promise<IdeContext>;
  openDiff(
    body: { path: string; original: string; proposed: string; title?: string },
    signal?: AbortSignal,
  ): Promise<void>;
  openFile(body: { path: string; line?: number }, signal?: AbortSignal): Promise<void>;
};

export class IdeRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IdeRequestError";
  }
}

const SEVERITIES = new Set<IdeSeverity>(["error", "warning", "info", "hint"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value);
}

function lineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Keeps only the parts of a /v1/context answer that match the contract. */
export function sanitizeIdeContext(value: unknown): IdeContext {
  if (!isRecord(value)) throw new IdeRequestError("IDE context is not a JSON object");
  const context: IdeContext = { openFiles: [], diagnostics: [] };
  if (absPath(value["activeFile"])) context.activeFile = value["activeFile"];
  const selection = value["selection"];
  if (
    isRecord(selection) &&
    absPath(selection["path"]) &&
    lineNumber(selection["startLine"]) &&
    lineNumber(selection["endLine"]) &&
    selection["endLine"] >= selection["startLine"] &&
    typeof selection["text"] === "string"
  ) {
    context.selection = {
      path: selection["path"],
      startLine: selection["startLine"],
      endLine: selection["endLine"],
      text: selection["text"].slice(0, MAX_SELECTION_CHARS),
    };
  }
  if (Array.isArray(value["openFiles"])) {
    context.openFiles = value["openFiles"].filter(absPath).slice(0, MAX_OPEN_FILES);
  }
  if (Array.isArray(value["diagnostics"])) {
    for (const entry of value["diagnostics"]) {
      if (context.diagnostics.length >= MAX_DIAGNOSTICS) break;
      if (!isRecord(entry) || !absPath(entry["path"]) || !lineNumber(entry["line"])) continue;
      if (typeof entry["severity"] !== "string" || !SEVERITIES.has(entry["severity"] as IdeSeverity)) continue;
      if (typeof entry["message"] !== "string") continue;
      const column = lineNumber(entry["column"]) ? entry["column"] : 1;
      context.diagnostics.push({
        path: entry["path"],
        line: entry["line"],
        column,
        severity: entry["severity"] as IdeSeverity,
        message: entry["message"].slice(0, MAX_MESSAGE_CHARS),
        ...(typeof entry["source"] === "string" ? { source: entry["source"].slice(0, 64) } : {}),
      });
    }
  }
  return context;
}

type CallOptions = { method: "GET" | "POST"; path: string; body?: unknown; signal?: AbortSignal };

export function createIdeClient(lock: { port: number; token: string }, opts: { timeoutMs?: number } = {}): IdeClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = ({ method, path, body, signal }: CallOptions): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new IdeRequestError("IDE request cancelled"));
        return;
      }
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const req = httpRequest(
        {
          host: IDE_HOST,
          port: lock.port,
          method,
          path,
          headers: {
            Authorization: `Bearer ${lock.token}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              finish(new IdeRequestError("IDE response too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (error) => finish(new IdeRequestError(`IDE response failed: ${error.message}`)));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              finish(
                new IdeRequestError(`IDE answered HTTP ${status}${status === 401 ? " (token rejected)" : ""}`, status),
              );
              return;
            }
            try {
              finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            } catch {
              finish(new IdeRequestError("IDE answered with invalid JSON", status));
            }
          });
        },
      );
      const onAbort = (): void => {
        req.destroy();
        finish(new IdeRequestError("IDE request cancelled"));
      };
      timer = setTimeout(() => {
        req.destroy();
        finish(new IdeRequestError(`IDE did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (error) => finish(new IdeRequestError(`IDE unreachable: ${error.message}`)));
      req.end(payload);
    });

  const expectOk = (value: unknown): void => {
    if (!isRecord(value) || value["ok"] !== true) throw new IdeRequestError("IDE did not confirm the request");
  };

  return {
    async getContext(signal) {
      return sanitizeIdeContext(await call({ method: "GET", path: "/v1/context", ...(signal ? { signal } : {}) }));
    },
    async openDiff(body, signal) {
      expectOk(await call({ method: "POST", path: "/v1/openDiff", body, ...(signal ? { signal } : {}) }));
    },
    async openFile(body, signal) {
      expectOk(await call({ method: "POST", path: "/v1/openFile", body, ...(signal ? { signal } : {}) }));
    },
  };
}
