/**
 * Small HTTP helpers shared by rest.ts and the route-group modules under
 * routes/: JSON responses, the structured API error shape, and the size-capped
 * body reader + JSON-parsing wrapper.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Deliberately no Access-Control-Allow-Origin header (same-origin UI only).
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendApiError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering but do NOT destroy the socket: destroying would tear
        // the connection down before the 413 response can reach the client.
        // Detaching the data listener while staying in flowing mode discards
        // the rest of the body, so the request completes and the keep-alive
        // connection stays usable for the client's next request.
        req.off("data", onData);
        req.resume();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** True when readBody rejected because the body exceeded its size cap. */
export function isBodyTooLarge(err: unknown): boolean {
  return err instanceof Error && err.message === "request body too large";
}

/**
 * Reads and JSON-parses a request body, answering the error response itself
 * when reading or parsing fails. Returns `undefined` exactly when a response
 * has already been sent — callers must bail out with a bare `return`:
 *  - an oversized body (readBody's too-large rejection) → 413 `too_large`
 *    (previously every route except /api/upload surfaced this as a 500 via
 *    the trailing catch);
 *  - invalid JSON → 400 "body must be valid JSON".
 * With `emptyOk`, an empty/whitespace-only body parses as `{}` (routes whose
 * parameters are all optional). `maxBytes`/`tooLargeMessage` let the routes
 * with larger caps (PUT /api/file, POST /api/upload) keep their limits and
 * wording. Note JSON.parse never yields `undefined`, so a successful parse is
 * always distinguishable from the error-already-sent sentinel.
 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { emptyOk?: boolean; maxBytes?: number; tooLargeMessage?: string } = {},
): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readBody(req, opts.maxBytes);
  } catch (err) {
    if (isBodyTooLarge(err)) {
      sendApiError(res, 413, "too_large", opts.tooLargeMessage ?? "request body too large");
      return undefined;
    }
    throw err; // socket-level read failure — the trailing catch answers
  }
  if (opts.emptyOk === true && raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    sendApiError(res, 400, "bad_request", "body must be valid JSON");
    return undefined;
  }
}
