import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearFilesCacheForTests,
  listWorkspaceFiles,
  saveUpload,
  searchWorkspaceContent,
  UploadError,
} from "../src/files.js";
import { startServer, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-files";

let workspace: string;
let server: RunningServer;
let base: string;

// A tiny 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

function upload(body: unknown): Promise<Response> {
  return authed("/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  workspace = makeWorkspace();
  writeFileIn(workspace, "package.json", "{}");
  writeFileIn(workspace, "src/app.ts", "export {};\n");
  writeFileIn(workspace, "src/lib/util.ts", "export {};\n");
  writeFileIn(workspace, "README.md", "# fixture\n");
  // All of these must be invisible to /api/files:
  writeFileIn(workspace, "node_modules/dep/index.js", "module.exports = 1;\n");
  writeFileIn(workspace, ".git/HEAD", "ref: refs/heads/main\n");
  writeFileIn(workspace, "dist/bundle.js", "var x;\n");
  writeFileIn(workspace, ".seekforge/sessions/s1/session.json", "{}");
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("GET /api/files", () => {
  it("lists workspace files, respecting ignore dirs and dot-directories", async () => {
    const res = await authed("/api/files");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.files).toContain("package.json");
    expect(body.files).toContain("src/app.ts");
    expect(body.files).toContain("src/lib/util.ts");
    expect(body.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(body.files.some((f) => f.startsWith(".git/"))).toBe(false);
    expect(body.files.some((f) => f.startsWith("dist/"))).toBe(false);
    expect(body.files.some((f) => f.startsWith(".seekforge/"))).toBe(false);
  });

  it("lists shallow files before deep ones (BFS order)", async () => {
    const body = (await (await authed("/api/files")).json()) as { files: string[] };
    expect(body.files.indexOf("package.json")).toBeLessThan(body.files.indexOf("src/app.ts"));
    expect(body.files.indexOf("src/app.ts")).toBeLessThan(body.files.indexOf("src/lib/util.ts"));
  });

  it("filters by ?q= as a case-insensitive substring of the relative path", async () => {
    const body = (await (await authed("/api/files?q=UTIL")).json()) as { files: string[] };
    expect(body.files).toEqual(["src/lib/util.ts"]);
    const none = (await (await authed("/api/files?q=no-such-file")).json()) as { files: string[] };
    expect(none.files).toEqual([]);
  });

  it("caps the list and reports truncation (listWorkspaceFiles limit)", async () => {
    const capped = await listWorkspaceFiles(workspace, "", 2);
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    const all = await listWorkspaceFiles(workspace);
    expect(all.truncated).toBe(false);
  });
});

describe("POST /api/upload", () => {
  it("saves a png under .seekforge/uploads and returns its workspace-relative path", async () => {
    const res = await upload({ name: "shot.png", dataBase64: PNG_BASE64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/^\.seekforge\/uploads\/img-[a-z0-9-]+\.png$/);
    const saved = readFileSync(join(workspace, body.path));
    expect(saved.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
  });

  it("accepts a data-URL prefix and only uses the extension of name", async () => {
    const res = await upload({
      name: "weird name (1).JPEG",
      dataBase64: `data:image/jpeg;base64,${PNG_BASE64}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/\.jpeg$/);
    expect(body.path).not.toContain("weird");
    expect(existsSync(join(workspace, body.path))).toBe(true);
  });

  it("rejects an uploads-directory symlink that escapes the workspace", () => {
    const symlinkWorkspace = makeWorkspace();
    const outside = makeWorkspace();
    mkdirSync(join(symlinkWorkspace, ".seekforge"), { recursive: true });
    symlinkSync(outside, join(symlinkWorkspace, ".seekforge", "uploads"), "dir");

    expect(() => saveUpload(symlinkWorkspace, "shot.png", PNG_BASE64)).toThrowError(UploadError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects non-image extensions with 400", async () => {
    for (const name of ["evil.sh", "note.txt", "noext"]) {
      const res = await upload({ name, dataBase64: PNG_BASE64 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_request");
    }
  });

  it("rejects an image over 4MB decoded with 413 too_large", async () => {
    const big = Buffer.alloc(4_000_001).toString("base64");
    const res = await upload({ name: "big.png", dataBase64: big });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("too_large");
  });

  it("rejects malformed bodies with 400", async () => {
    expect((await upload({ name: "a.png" })).status).toBe(400);
    expect((await upload({ dataBase64: PNG_BASE64 })).status).toBe(400);
    expect((await upload({ name: "a.png", dataBase64: "" })).status).toBe(400);
    const notJson = await authed("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("rejects non-canonical and malformed base64 without creating an upload", async () => {
    const uploadDir = join(workspace, ".seekforge", "uploads");
    const before = readdirSync(uploadDir).sort();
    for (const dataBase64 of ["not-base64!!", "AAAA=", "data:image/png,AAAA"]) {
      const res = await upload({ name: "bad.png", dataBase64 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("bad_request");
    }
    expect(readdirSync(uploadDir).sort()).toEqual(before);
  });

  it("is 404 for an unknown workspace id", async () => {
    const res = await authed("/api/files?ws=nope");
    expect(res.status).toBe(404);
  });
});

describe("files TTL cache", () => {
  it("serves immediate repeat calls from one cached walk, consistently", async () => {
    clearFilesCacheForTests();
    const first = (await (await authed("/api/files")).json()) as { files: string[]; truncated: boolean };
    // A file created AFTER the walk is invisible while the cache entry lives…
    writeFileIn(workspace, "src/created-after-walk.ts", "export {};\n");
    const second = (await (await authed("/api/files")).json()) as { files: string[]; truncated: boolean };
    expect(second).toEqual(first);
    expect(second.files).not.toContain("src/created-after-walk.ts");
    // …and shows up once the cache is dropped (in production: after the TTL).
    clearFilesCacheForTests();
    const third = (await (await authed("/api/files")).json()) as { files: string[] };
    expect(third.files).toContain("src/created-after-walk.ts");
  });

  it("applies the ?q= filter on the cached list (filtered calls stay fresh-consistent)", async () => {
    clearFilesCacheForTests();
    const all = (await (await authed("/api/files")).json()) as { files: string[] };
    const filtered = (await (await authed("/api/files?q=UTIL")).json()) as { files: string[] };
    expect(filtered.files).toEqual(all.files.filter((f) => f.toLowerCase().includes("util")));
  });

  it("does not follow a cached directory after it is swapped for an escaping symlink", async () => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    writeFileIn(ws, "cached/secret.txt", "workspace text\n");
    writeFileIn(outside, "secret.txt", "outside needle\n");
    clearFilesCacheForTests();
    expect((await listWorkspaceFiles(ws)).files).toContain("cached/secret.txt");

    renameSync(join(ws, "cached"), join(ws, "cached-original"));
    symlinkSync(outside, join(ws, "cached"), "dir");

    const result = await searchWorkspaceContent(ws, "outside needle");
    expect(result.hits).toEqual([]);
  });

  it("preserves the query when a larger limit requires an uncached walk", async () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 2001; i++) {
      writeFileIn(ws, `many/file-${String(i).padStart(4, "0")}.txt`, "x\n");
    }
    writeFileIn(ws, "many/needle.txt", "x\n");
    clearFilesCacheForTests();
    await listWorkspaceFiles(ws);

    const result = await listWorkspaceFiles(ws, "needle", 3000);
    expect(result.files).toEqual(["many/needle.txt"]);
  }, 15_000);
});
