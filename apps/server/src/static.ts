/**
 * Static serving of the web UI (apps/desktop vite build output) at /.
 * Falls back to a plain info page when the UI has not been built.
 * All resolved paths are confined to the static root (no path traversal).
 */

import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Static UI assets are public and must not become an unbounded memory/disk-read surface. */
export const MAX_STATIC_FILE_BYTES = 25 * 1024 * 1024;

type OpenedStaticFile = { fd: number; size: number };

/**
 * Returns the directory to serve at /, or undefined when there is no built UI.
 * Default: apps/desktop/dist resolved relative to this package — the same
 * relative location holds for the CLI bundle (apps/cli/dist/index.js).
 */
export function resolveStaticRoot(override?: string): string | undefined {
  const candidates = override
    ? [override]
    : [
        // Monorepo / source: from apps/server (or the in-tree cli bundle at
        // apps/cli/dist), ../../desktop/dist is the vite build output.
        fileURLToPath(new URL("../../desktop/dist", import.meta.url)),
        // Published npm package: the web UI is copied next to the cli bundle
        // (apps/cli/dist/web) at publish time, so `seekforge serve` ships a UI.
        fileURLToPath(new URL("./web", import.meta.url)),
      ];
  for (const root of candidates) {
    try {
      const canonicalRoot = realpathSync(resolve(root));
      if (statSync(canonicalRoot).isDirectory()) {
        const index = openStaticFile(canonicalRoot, join(canonicalRoot, "index.html"));
        if (index) {
          closeSync(index.fd);
          return canonicalRoot;
        }
      }
    } catch {
      // Missing or unsafe candidates are treated as an unbuilt UI.
    }
  }
  return undefined;
}

/** Resolves a URL path inside root; undefined when it would escape root. */
function safeJoin(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const resolved = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return resolved;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Opens and reads a regular file without following static-root-local symlinks. */
function openStaticFile(root: string, path: string): OpenedStaticFile | undefined {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;

  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    const parent = dirname(path);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));

    // Canonical equality rejects symlinks in every path component. Descriptor
    // identity checks ensure neither path was swapped between resolution/open.
    if (realpathSync(parent) !== parent || realpathSync(path) !== path) return undefined;
    const parentPathStat = statSync(parent);
    const filePathStat = statSync(path);
    const fileStat = fstatSync(fileFd);
    if (
      !sameFile(fstatSync(parentFd), parentPathStat) ||
      !sameFile(fileStat, filePathStat) ||
      !fileStat.isFile() ||
      !Number.isSafeInteger(fileStat.size) ||
      fileStat.size < 0 ||
      fileStat.size > MAX_STATIC_FILE_BYTES
    ) {
      return undefined;
    }
    const opened = { fd: fileFd, size: fileStat.size };
    fileFd = undefined;
    return opened;
  } catch {
    return undefined;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type ServeStaticOptions = {
  root: string | undefined;
  pathname: string;
  port: number;
  workspace: string;
  head?: boolean;
};

export function serveStatic(res: ServerResponse, opts: ServeStaticOptions): void {
  const notFound = () => {
    const data = Buffer.from(JSON.stringify({ error: { code: "not_found", message: `not found: ${opts.pathname}` } }));
    res.writeHead(404, { "content-type": "application/json", "content-length": String(data.length) });
    res.end(opts.head ? undefined : data);
  };

  if (!opts.root) {
    if (opts.pathname !== "/") {
      notFound();
      return;
    }
    // Static pages are served without auth, so this page must NOT include
    // the token — `seekforge serve` prints the full token URL to the terminal.
    const data = Buffer.from(
      `<!doctype html><html><head><meta charset="utf-8"><title>SeekForge server</title></head><body>` +
        `<h1>SeekForge server</h1>` +
        `<p>Workspace: <code>${escapeHtml(opts.workspace)}</code></p>` +
        `<p>The web UI is not built (apps/desktop/dist is missing). ` +
        `The REST API (<code>/api/*</code>) and WebSocket (<code>/ws</code>) are available with the token.</p>` +
        `<p>Open the token URL printed by <code>seekforge serve</code> (port ${opts.port}).</p>` +
        `</body></html>`,
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(data.length) });
    res.end(opts.head ? undefined : data);
    return;
  }

  const target = safeJoin(opts.root, opts.pathname === "/" ? "/index.html" : opts.pathname);
  if (!target) {
    notFound();
    return;
  }

  let file = target;
  let opened = openStaticFile(opts.root, file);
  if (!opened) {
    // SPA fallback: extension-less client-side routes get index.html.
    if (extname(file) !== "") {
      notFound();
      return;
    }
    file = join(opts.root, "index.html");
    opened = openStaticFile(opts.root, file);
    if (!opened) {
      notFound();
      return;
    }
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": String(opened.size) });
  if (opts.head || opened.size === 0) {
    closeSync(opened.fd);
    res.end();
    return;
  }

  // Read at most the descriptor size verified above. Concurrent appends cannot
  // extend the response, and streaming avoids one full-file allocation/request.
  const stream = createReadStream(file, { fd: opened.fd, autoClose: true, start: 0, end: opened.size - 1 });
  stream.once("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}
