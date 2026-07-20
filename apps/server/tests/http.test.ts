import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isBodyTooLarge, readBody } from "../src/http.js";

function request(headers: IncomingMessage["headers"] = {}): IncomingMessage & PassThrough {
  const stream = new PassThrough({ autoDestroy: false }) as IncomingMessage & PassThrough;
  Object.defineProperty(stream, "headers", { value: headers });
  return stream;
}

describe("readBody lifecycle", () => {
  it("removes request listeners after a successful read", async () => {
    const req = request();
    const body = readBody(req);
    req.end("hello");

    await expect(body).resolves.toBe("hello");
    for (const event of ["data", "end", "error", "aborted"]) expect(req.listenerCount(event)).toBe(0);
  });

  it("rejects an aborted request and removes its listeners", async () => {
    const req = request();
    const body = readBody(req);
    req.emit("aborted");

    await expect(body).rejects.toThrow("request body aborted");
    for (const event of ["data", "end", "aborted"]) expect(req.listenerCount(event)).toBe(0);
    expect(req.listenerCount("error")).toBe(1);
    expect(() => req.emit("error", new Error("late abort error"))).not.toThrow();
    req.emit("close");
    expect(req.listenerCount("error")).toBe(0);
  });

  it("rejects an oversized Content-Length before buffering chunks", async () => {
    const req = request({ "content-length": "1001" });
    const body = readBody(req, 1000);
    req.end("small");

    await expect(body).rejects.toSatisfy(isBodyTooLarge);
    expect(req.listenerCount("error")).toBe(1);
    expect(() => req.emit("error", new Error("late transport error"))).not.toThrow();
    req.emit("close");
    expect(req.listenerCount("error")).toBe(0);
  });

  it("rejects invalid byte limits before attaching listeners", async () => {
    const req = request();
    await expect(readBody(req, 0)).rejects.toThrow("maxBytes must be a positive safe integer");
    for (const event of ["data", "end", "error", "aborted", "close"]) expect(req.listenerCount(event)).toBe(0);
  });
});
