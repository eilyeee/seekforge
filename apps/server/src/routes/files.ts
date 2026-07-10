/**
 * File routes: the @ file-picker index (/api/files), content search
 * (/api/search), the file browser/viewer/editor (/api/tree, /api/file), raw
 * upload serving (/api/raw) and image uploads (/api/upload).
 *
 * FileBrowseError / RawFileError / UploadError thrown by ../files.js carry
 * their own {status, code, message} and are mapped centrally in handleApi's
 * trailing catch.
 */

import {
  listTree,
  listWorkspaceFiles,
  readRawUpload,
  readTextFile,
  saveUpload,
  searchWorkspaceContent,
  writeTextFile,
} from "../files.js";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, workspace }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/files") {
    // @ file picker index: ignore-aware scan, capped at 2000 paths.
    return sendJson(res, 200, await listWorkspaceFiles(workspace, url.searchParams.get("q") ?? ""));
  }

  // Project-wide content search (literal or regex), bounded.
  if (method === "GET" && path === "/api/search") {
    return sendJson(
      res,
      200,
      await searchWorkspaceContent(workspace, url.searchParams.get("q") ?? "", {
        caseSensitive: url.searchParams.get("case") === "1",
        regex: url.searchParams.get("regex") === "1",
      }),
    );
  }

  // File browser: one directory listing (dirs first then files, alphabetical;
  // .git/denylisted/dot-dirs and sensitive files hidden). ?path empty = root.
  if (method === "GET" && path === "/api/tree") {
    // FileBrowseError (bad/denied path, missing dir) maps to its status/code
    // in the trailing catch.
    return sendJson(res, 200, listTree(workspace, url.searchParams.get("path") ?? ""));
  }

  // File viewer/editor.
  if (method === "GET" && path === "/api/file") {
    return sendJson(res, 200, readTextFile(workspace, url.searchParams.get("path") ?? ""));
  }

  if (method === "PUT" && path === "/api/file") {
    const body = await readJsonBody(req, res, { maxBytes: 4_000_000 });
    if (body === undefined) return;
    const { path: rel, content } = (body ?? {}) as { path?: unknown; content?: unknown };
    if (typeof rel !== "string" || rel.trim() === "" || typeof content !== "string") {
      return sendApiError(res, 400, "bad_request", "body must be {path: string, content: string}");
    }
    writeTextFile(workspace, rel, content);
    return sendJson(res, 200, { ok: true });
  }

  // Raw bytes of an agent-uploaded image (so the UI renders real <img>
  // thumbnails). Hard-confined to .seekforge/uploads/ — NOT a general
  // file-serving endpoint. See readRawUpload for the confinement rules.
  if (method === "GET" && path === "/api/raw") {
    // RawFileError (confinement/type/size violations) maps to its
    // status/code in the trailing catch.
    const { data, contentType } = readRawUpload(workspace, url.searchParams.get("path") ?? "");
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(data.length),
      // Uploads are immutable (unique stamped names) — safe to cache.
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(data);
    return;
  }

  if (method === "POST" && path === "/api/upload") {
    // 4MB decoded cap → base64 plus JSON wrapper stays under ~6MB raw body.
    const body = await readJsonBody(req, res, {
      maxBytes: 6_000_000,
      tooLargeMessage: "request body too large (4MB image cap)",
    });
    if (body === undefined) return;
    const { name, dataBase64 } = (body ?? {}) as { name?: unknown; dataBase64?: unknown };
    if (typeof name !== "string" || name === "" || typeof dataBase64 !== "string" || dataBase64 === "") {
      return sendApiError(res, 400, "bad_request", "body must be {name, dataBase64}");
    }
    // UploadError (bad extension, oversized decode) maps to its status/code
    // in the trailing catch.
    return sendJson(res, 200, saveUpload(workspace, name, dataBase64));
  }
}
