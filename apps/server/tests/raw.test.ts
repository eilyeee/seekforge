import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { RawFileError, readRawUpload } from "../src/files.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-raw";

let workspace: string;
let server: RunningServer;
let base: string;

// A tiny 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

beforeAll(async () => {
  workspace = makeWorkspace();
  writeFileIn(workspace, ".seekforge/uploads/img-abc.png", "");
  writeFileSync(join(workspace, ".seekforge/uploads/img-abc.png"), PNG_BYTES);
  // A non-image and a secret outside uploads, to prove confinement.
  writeFileIn(workspace, ".seekforge/uploads/note.txt", "secret");
  writeFileIn(workspace, "secret.png", "outside-uploads");
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("GET /api/raw", () => {
  it("streams an uploaded png with the right Content-Type and bytes", async () => {
    const res = await authed("/api/raw?path=.seekforge/uploads/img-abc.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("refuses a path that escapes the workspace (400)", async () => {
    const res = await authed(`/api/raw?path=${encodeURIComponent("../../../etc/passwd")}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("refuses a file outside .seekforge/uploads/ (400)", async () => {
    const res = await authed("/api/raw?path=secret.png");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects an uploads symlink even when its target stays inside the workspace", () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, ".seekforge"), { recursive: true });
    writeFileIn(ws, ".env", "SECRET=outside-upload-boundary\n");
    symlinkSync("..", join(ws, ".seekforge", "uploads"), "dir");
    symlinkSync(".env", join(ws, "secret.png"), "file");

    expect(() => readRawUpload(ws, ".seekforge/uploads/secret.png")).toThrowError(RawFileError);
    try {
      readRawUpload(ws, ".seekforge/uploads/secret.png");
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "bad_request" });
    }
  });

  it("404s a missing file inside uploads", async () => {
    const res = await authed("/api/raw?path=.seekforge/uploads/nope.png");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("415s a non-image extension even inside uploads", async () => {
    const res = await authed("/api/raw?path=.seekforge/uploads/note.txt");
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("400s a missing path param", async () => {
    const res = await authed("/api/raw");
    expect(res.status).toBe(400);
  });

  it("requires the token like every /api/* route", async () => {
    const res = await fetch(`${base}/api/raw?path=.seekforge/uploads/img-abc.png`);
    expect(res.status).toBe(401);
  });
});
