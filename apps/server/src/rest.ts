/**
 * REST endpoints under /api (SERVER-API.md). All responses are JSON;
 * errors are {error: {code, message}} with an appropriate HTTP status.
 */

import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { promisify } from "node:util";
import {
  applyProposal,
  approveMemoryCandidate,
  createDefaultDispatcher,
  createMcpClient,
  listEvolutionProposals,
  listMemoryCandidates,
  listSessions,
  loadAgentDefinitions,
  loadSessionMessages,
  loadSkills,
  readCheckpoints,
  readProjectMemory,
  readSessionMeta,
  rejectMemoryCandidate,
  rewindSession,
  setEvolutionProposalStatus,
} from "@seekforge/core";
import { ConfigValueError, loadConfig, maskedConfig, setConfigValue } from "./config.js";
import { WorktreeError, type WorktreeManager } from "./worktrees.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export type RestContext = {
  registry: WorkspaceRegistry;
  worktrees: WorktreeManager;
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
    // Global routes (not scoped to a workspace).
    if (method === "GET" && path === "/api/health") {
      return sendJson(res, 200, {
        version: ctx.version,
        workspace: ctx.registry.default.path,
        workspaces: ctx.registry.summary,
      });
    }

    if (method === "GET" && path === "/api/workspaces") {
      return sendJson(res, 200, ctx.registry.summary);
    }

    // Every remaining route is scoped to a workspace selected by `?ws=<id>`
    // (default = first workspace when omitted, preserving old clients).
    const wsId = url.searchParams.get("ws");
    const ws = ctx.registry.resolve(wsId);
    if (!ws) {
      return sendApiError(res, 404, "not_found", `unknown workspace: ${String(wsId)}`);
    }
    const workspace = ws.path;

    // Worktree sessions — `?ws=` selects the BASE workspace for create/list;
    // merge/delete identify the worktree by :id (its own record knows the base).
    if (path === "/api/worktrees" && method === "GET") {
      return sendJson(res, 200, await ctx.worktrees.list(ws));
    }

    if (path === "/api/worktrees" && method === "POST") {
      const raw = await readBody(req);
      let name: string | undefined;
      if (raw.trim() !== "") {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return sendApiError(res, 400, "bad_request", "body must be valid JSON");
        }
        const candidate = (body ?? {}) as { name?: unknown };
        if (candidate.name !== undefined && typeof candidate.name !== "string") {
          return sendApiError(res, 400, "bad_request", "body must be {name?: string}");
        }
        name = candidate.name;
      }
      return sendJson(res, 200, await ctx.worktrees.create(ws, name));
    }

    if (method === "POST" && segs.length === 4 && segs[1] === "worktrees" && segs[3] === "merge") {
      return sendJson(res, 200, await ctx.worktrees.merge(segs[2]!));
    }

    if (method === "DELETE" && segs.length === 3 && segs[1] === "worktrees") {
      await ctx.worktrees.remove(segs[2]!);
      return sendJson(res, 200, { deleted: true });
    }

    if (method === "GET" && path === "/api/project") {
      return sendJson(res, 200, await detectProject(workspace));
    }

    if (method === "GET" && path === "/api/sessions") {
      return sendJson(res, 200, listSessions(workspace));
    }

    if (method === "GET" && path === "/api/diff") {
      const staged = url.searchParams.get("staged") === "1";
      return sendJson(res, 200, await gitDiff(workspace, staged));
    }

    if (method === "GET" && segs.length === 3 && segs[1] === "sessions") {
      const id = segs[2]!;
      const meta = isSafeId(id) ? readSessionMeta(workspace, id) : undefined;
      if (!meta) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      let messages: ReturnType<typeof loadSessionMessages> = [];
      try {
        messages = loadSessionMessages(workspace, id);
      } catch {
        // a session may exist with no messages.jsonl yet
      }
      return sendJson(res, 200, { meta, messages });
    }

    if (method === "GET" && path === "/api/skills") {
      return sendJson(
        res,
        200,
        loadSkills(workspace).map(({ content: _content, ...rest }) => rest),
      );
    }

    if (method === "GET" && segs.length === 3 && segs[1] === "skills") {
      const skill = loadSkills(workspace).find((s) => s.id === segs[2]);
      if (!skill) return sendApiError(res, 404, "not_found", `skill not found: ${segs[2]}`);
      return sendJson(res, 200, skill);
    }

    if (method === "GET" && path === "/api/memory") {
      return sendJson(res, 200, {
        projectMd: readProjectMemory(workspace) ?? null,
        candidates: listMemoryCandidates(workspace),
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
            ? approveMemoryCandidate(workspace, id)
            : rejectMemoryCandidate(workspace, id);
        return sendJson(res, 200, candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("candidate not found")) {
          return sendApiError(res, 404, "not_found", message);
        }
        throw err;
      }
    }

    if (method === "GET" && path === "/api/agents") {
      // Prompt bodies are stripped from the list view (GET /api/agents/:id has them).
      return sendJson(
        res,
        200,
        loadAgentDefinitions(workspace).map(({ body: _body, ...rest }) => rest),
      );
    }

    if (method === "GET" && segs.length === 3 && segs[1] === "agents") {
      const def = loadAgentDefinitions(workspace).find((d) => d.id === segs[2]);
      if (!def) return sendApiError(res, 404, "not_found", `agent not found: ${segs[2]}`);
      return sendJson(res, 200, def);
    }

    if (method === "GET" && path === "/api/evolution") {
      // Newest first within each group, pending proposals before reviewed ones.
      const proposals = listEvolutionProposals(workspace);
      const pendingFirst = [
        ...proposals.filter((p) => p.status === "pending"),
        ...proposals.filter((p) => p.status !== "pending"),
      ];
      return sendJson(res, 200, pendingFirst);
    }

    if (
      method === "POST" &&
      segs.length === 4 &&
      segs[1] === "evolution" &&
      (segs[3] === "accept" || segs[3] === "reject" || segs[3] === "apply")
    ) {
      const id = segs[2]!;
      try {
        if (segs[3] === "apply") {
          // applyProposal returns {proposal, changedPath} (the file it wrote).
          return sendJson(res, 200, applyProposal(workspace, id));
        }
        const proposal = setEvolutionProposalStatus(
          workspace,
          id,
          segs[3] === "accept" ? "accepted" : "rejected",
        );
        return sendJson(res, 200, proposal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("proposal not found")) {
          return sendApiError(res, 404, "not_found", message);
        }
        // Wrong-state transitions and apply failures (e.g. skill_exists) are conflicts.
        return sendApiError(res, 409, "conflict", message);
      }
    }

    if (method === "GET" && path === "/api/mcp") {
      // Configured servers only — never spawned here, env VALUES never exposed.
      const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
      return sendJson(
        res,
        200,
        servers.map(([name, cfg]) => ({
          name,
          command: cfg.command,
          args: cfg.args ?? [],
          trusted: cfg.trusted === true,
          envKeys: Object.keys(cfg.env ?? {}),
        })),
      );
    }

    if (method === "POST" && segs.length === 4 && segs[1] === "mcp" && segs[3] === "tools") {
      const name = segs[2]!;
      const config = (loadConfig(workspace).mcpServers ?? {})[name];
      if (!config) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
      const client = createMcpClient({ name, config });
      try {
        const tools = await client.listTools();
        return sendJson(res, 200, {
          tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return sendApiError(res, 502, "mcp_error", message);
      } finally {
        client.dispose();
      }
    }

    if (method === "POST" && path === "/api/rewind") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { sessionId, dryRun } = (body ?? {}) as { sessionId?: unknown; dryRun?: unknown };
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return sendApiError(res, 400, "bad_request", "body must be {sessionId, dryRun?}");
      }
      if (!isSafeId(sessionId) || !readSessionMeta(workspace, sessionId)) {
        return sendApiError(res, 404, "not_found", `session not found: ${sessionId}`);
      }
      if (readCheckpoints(workspace, sessionId).length === 0) {
        return sendApiError(res, 404, "not_found", `session ${sessionId} has no checkpoints to rewind`);
      }
      return sendJson(res, 200, rewindSession(workspace, sessionId, { dryRun: dryRun === true }));
    }

    if (method === "GET" && path === "/api/config") {
      return sendJson(res, 200, maskedConfig(workspace));
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
        setConfigValue(workspace, key, value, global === true);
      } catch (err) {
        if (err instanceof ConfigValueError) {
          return sendApiError(res, 400, "bad_request", err.message);
        }
        throw err;
      }
      return sendJson(res, 200, maskedConfig(workspace));
    }

    return sendApiError(res, 404, "not_found", `no such endpoint: ${method} ${path}`);
  } catch (err) {
    if (err instanceof WorktreeError) {
      return sendApiError(res, err.status, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return sendApiError(res, 500, "internal", message);
  }
}
