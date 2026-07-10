/**
 * Skill, subagent and evolution-proposal routes: skill CRUD + import,
 * agent definitions + import, and the self-evolution proposal review flow.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  applyProposal,
  BUILTIN_SKILLS,
  createSkillScaffold,
  importExternalAgent,
  importExternalSkill,
  listEvolutionProposals,
  loadAgentDefinitions,
  loadSkills,
  removeSkill,
  setEvolutionProposalStatus,
  setSkillEnabled,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

/** Skills shipped in-package are immutable: refuse to mutate/delete them. */
function isBuiltinSkill(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id);
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/skills") {
    return sendJson(
      res,
      200,
      loadSkills(workspace).map(({ content: _content, ...rest }) => rest),
    );
  }

  // Import an external (Claude-Code-style) SKILL.md. Checked before the
  // GET-by-id route so :id never captures "import".
  if (method === "POST" && segs.length === 3 && segs[1] === "skills" && segs[2] === "import") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { path: src, global } = (body ?? {}) as { path?: unknown; global?: unknown };
    if (typeof src !== "string" || src.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must be {path: string, global?: boolean}");
    }
    const targetRoot =
      global === true
        ? join(homedir(), ".seekforge", "skills")
        : join(workspace, ".seekforge", "skills");
    try {
      const { dir, skill } = importExternalSkill(src, { targetRoot });
      return sendJson(res, 200, { ok: true, dir, skill });
    } catch (err) {
      return sendApiError(res, 400, "bad_request", err instanceof Error ? err.message : String(err));
    }
  }

  // Scaffold a new project skill directory.
  if (method === "POST" && path === "/api/skills") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { id } = (body ?? {}) as { id?: unknown };
    if (typeof id !== "string" || id.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must be {id: string}");
    }
    try {
      const dir = createSkillScaffold(workspace, id);
      return sendJson(res, 200, { ok: true, dir });
    } catch (err) {
      return sendApiError(res, 400, "bad_request", err instanceof Error ? err.message : String(err));
    }
  }

  if (method === "GET" && segs.length === 3 && segs[1] === "skills") {
    const skill = loadSkills(workspace).find((s) => s.id === segs[2]);
    if (!skill) return sendApiError(res, 404, "not_found", `skill not found: ${segs[2]}`);
    return sendJson(res, 200, skill);
  }

  // Enable/disable a skill at the project (default) or global layer.
  if (method === "PUT" && segs.length === 3 && segs[1] === "skills") {
    const id = segs[2]!;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { enabled, scope } = (body ?? {}) as { enabled?: unknown; scope?: unknown };
    if (typeof enabled !== "boolean") {
      return sendApiError(res, 400, "bad_request", "body must be {enabled: boolean, scope?: \"project\"|\"global\"}");
    }
    if (scope !== undefined && scope !== "project" && scope !== "global") {
      return sendApiError(res, 400, "bad_request", 'scope must be "project" or "global"');
    }
    const global = scope === "global";
    // Builtins are immutable in-package — reject mutating them.
    if (isBuiltinSkill(id)) {
      return sendApiError(res, 400, "bad_request", `cannot modify builtin skill "${id}"`);
    }
    try {
      const result = setSkillEnabled(workspace, id, enabled, { global });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendApiError(res, 400, "bad_request", err instanceof Error ? err.message : String(err));
    }
  }

  // Remove a project (default) or global skill directory.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "skills") {
    const id = segs[2]!;
    const scope = url.searchParams.get("scope");
    if (scope !== null && scope !== "project" && scope !== "global") {
      return sendApiError(res, 400, "bad_request", 'scope must be "project" or "global"');
    }
    if (isBuiltinSkill(id)) {
      return sendApiError(res, 400, "bad_request", `cannot remove builtin skill "${id}"`);
    }
    try {
      const result = removeSkill(workspace, id, { global: scope === "global" });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendApiError(res, 400, "bad_request", err instanceof Error ? err.message : String(err));
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

  // Import an external (Meta_Kim-style) agent .md. Checked before the
  // GET-by-id route so :id never captures "import".
  if (method === "POST" && segs.length === 3 && segs[1] === "agents" && segs[2] === "import") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { path: src, global } = (body ?? {}) as { path?: unknown; global?: unknown };
    if (typeof src !== "string" || src.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must be {path: string, global?: boolean}");
    }
    const targetRoot =
      global === true
        ? join(homedir(), ".seekforge", "agents")
        : join(workspace, ".seekforge", "agents");
    try {
      const { dir, agent, droppedTools } = importExternalAgent(src, { targetRoot });
      return sendJson(res, 200, { ok: true, dir, agent, droppedTools });
    } catch (err) {
      return sendApiError(res, 400, "bad_request", err instanceof Error ? err.message : String(err));
    }
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
}
