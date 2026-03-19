/**
 * REST endpoints under /api (SERVER-API.md). All responses are JSON;
 * errors are {error: {code, message}} with an appropriate HTTP status.
 */

import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  approveMemoryCandidate,
  createDefaultDispatcher,
  listMemoryCandidates,
  listSessions,
  loadSessionMessages,
  loadSkills,
  readProjectMemory,
  readSessionMeta,
  rejectMemoryCandidate,
} from "@seekforge/core";
import { ConfigValueError, maskedConfig, setConfigValue } from "./config.js";

export type RestContext = {
  workspace: string;
  version: string;
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Deliberately no Access-Control-Allow-Origin header (same-origin UI only).
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendApiError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** Rejects ids that could escape .seekforge/sessions/<id>/. */
function isSafeId(id: string): boolean {
  return id.length > 0 && !/[/\\]/.test(id) && !id.includes("..");
}

// One readonly dispatcher instance for GET /api/project.
const dispatcher = createDefaultDispatcher();

const execFileAsync = promisify(execFile);

/** Current git diff of the workspace (no shell; capped at 2 MB). */
async function gitDiff(workspace: string, staged: boolean): Promise<{ diff: string; truncated: boolean }> {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      maxBuffer: 10_000_000,
      timeout: 30_000,
    });
    const MAX = 2_000_000;
    return stdout.length > MAX
      ? { diff: stdout.slice(0, MAX), truncated: true }
      : { diff: stdout, truncated: false };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git diff failed: ${(e.stderr ?? e.message ?? "").slice(0, 500)}`);
  }
}

async function detectProject(workspace: string): Promise<unknown> {
  const result = await dispatcher.execute(
    { id: "server-detect", name: "detect_project", arguments: {} },
    {
      sessionId: "server",
      workspace,
      policy: { approvalMode: "auto", mode: "ask", commandAllowlist: [] },
      confirm: async () => false,
    },
  );
  const data = (result.ok ? result.data : {}) as {
    name?: string;
    languages?: string[];
    packageManager?: string;
    frameworks?: string[];
    scripts?: Record<string, string>;
  };
  return {
    path: workspace,
    name: data.name ?? basename(workspace),
    detect: {
      languages: data.languages ?? [],
      packageManager: data.packageManager ?? null,
      frameworks: data.frameworks ?? [],
      scripts: data.scripts ?? {},
    },
  };
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RestContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  // ["api", ...rest] — path params are URL-decoded per segment.
  const segs = path.split("/").filter(Boolean).map(decodeURIComponent);

  try {
    if (method === "GET" && path === "/api/health") {
      return sendJson(res, 200, { version: ctx.version, workspace: ctx.workspace });
    }

    if (method === "GET" && path === "/api/project") {
      return sendJson(res, 200, await detectProject(ctx.workspace));
    }

    if (method === "GET" && path === "/api/sessions") {
      return sendJson(res, 200, listSessions(ctx.workspace));
    }

    if (method === "GET" && path === "/api/diff") {
      const staged = url.searchParams.get("staged") === "1";
      return sendJson(res, 200, await gitDiff(ctx.workspace, staged));
    }

    if (method === "GET" && segs.length === 3 && segs[1] === "sessions") {
      const id = segs[2]!;
      const meta = isSafeId(id) ? readSessionMeta(ctx.workspace, id) : undefined;
      if (!meta) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      let messages: ReturnType<typeof loadSessionMessages> = [];
      try {
        messages = loadSessionMessages(ctx.workspace, id);
      } catch {
        // a session may exist with no messages.jsonl yet
      }
      return sendJson(res, 200, { meta, messages });
    }

    if (method === "GET" && path === "/api/skills") {
      return sendJson(
        res,
        200,
        loadSkills(ctx.workspace).map(({ content: _content, ...rest }) => rest),
      );
    }

    if (method === "GET" && segs.length === 3 && segs[1] === "skills") {
      const skill = loadSkills(ctx.workspace).find((s) => s.id === segs[2]);
      if (!skill) return sendApiError(res, 404, "not_found", `skill not found: ${segs[2]}`);
      return sendJson(res, 200, skill);
    }

    if (method === "GET" && path === "/api/memory") {
      return sendJson(res, 200, {
        projectMd: readProjectMemory(ctx.workspace) ?? null,
        candidates: listMemoryCandidates(ctx.workspace),
      });
    }

    if (
      method === "POST" &&
      segs.length === 4 &&
      segs[1] === "memory" &&
      (segs[3] === "approve" || segs[3] === "reject")
    ) {
      const id = segs[2]!;
      try {
        const candidate =
          segs[3] === "approve"
            ? approveMemoryCandidate(ctx.workspace, id)
            : rejectMemoryCandidate(ctx.workspace, id);
        return sendJson(res, 200, candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("candidate not found")) {
          return sendApiError(res, 404, "not_found", message);
        }
        throw err;
      }
    }

    if (method === "GET" && path === "/api/config") {
      return sendJson(res, 200, maskedConfig(ctx.workspace));
    }

    if (method === "PUT" && path === "/api/config") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { key, value, global } = (body ?? {}) as { key?: unknown; value?: unknown; global?: unknown };
      if (typeof key !== "string") {
        return sendApiError(res, 400, "bad_request", "body must be {key, value, global?}");
      }
      try {
        setConfigValue(ctx.workspace, key, value, global === true);
      } catch (err) {
        if (err instanceof ConfigValueError) {
          return sendApiError(res, 400, "bad_request", err.message);
        }
        throw err;
      }
      return sendJson(res, 200, maskedConfig(ctx.workspace));
    }

    return sendApiError(res, 404, "not_found", `no such endpoint: ${method} ${path}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendApiError(res, 500, "internal", message);
  }
}
