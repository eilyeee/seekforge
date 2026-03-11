/**
 * Static serving of the web UI (apps/desktop vite build output) at /.
 * Falls back to a plain info page when the UI has not been built.
 * All resolved paths are confined to the static root (no path traversal).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * Returns the directory to serve at /, or undefined when there is no built UI.
 * Default: apps/desktop/dist resolved relative to this package — the same
 * relative location holds for the CLI bundle (apps/cli/dist/index.js).
 */
export function resolveStaticRoot(override?: string): string | undefined {
  const root = override ?? fileURLToPath(new URL("../../desktop/dist", import.meta.url));
  return existsSync(join(root, "index.html")) ? resolve(root) : undefined;
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
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return resolved;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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
};

export function serveStatic(res: ServerResponse, opts: ServeStaticOptions): void {
  const notFound = () => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: `not found: ${opts.pathname}` } }));
  };

  if (!opts.root) {
    if (opts.pathname !== "/") return notFound();
    // Static pages are served without auth, so this page must NOT include
    // the token — `seekforge serve` prints the full token URL to the terminal.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>SeekForge server</title></head><body>` +
        `<h1>SeekForge server</h1>` +
        `<p>Workspace: <code>${escapeHtml(opts.workspace)}</code></p>` +
        `<p>The web UI is not built (apps/desktop/dist is missing). ` +
        `The REST API (<code>/api/*</code>) and WebSocket (<code>/ws</code>) are available with the token.</p>` +
        `<p>Open the token URL printed by <code>seekforge serve</code> (port ${opts.port}).</p>` +
        `</body></html>`,
    );
    return;
  }

  const target = safeJoin(opts.root, opts.pathname === "/" ? "/index.html" : opts.pathname);
  if (!target) return notFound();

  let file = target;
  if (!isFile(file)) {
    // SPA fallback: extension-less client-side routes get index.html.
    if (extname(file) !== "") return notFound();
    file = join(opts.root, "index.html");
    if (!isFile(file)) return notFound();
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(file));
}
