/**
 * Skill, subagent and evolution-proposal routes: skill CRUD + import,
 * agent definitions + import, and the self-evolution proposal review flow.
 */

import { join } from "node:path";
import {
  applyProposal,
  BUILTIN_SKILLS,
  createPluginScaffold,
  createSkillScaffold,
  importExternalAgent,
  importExternalSkill,
  installPlugin,
  listEvolutionProposals,
  loadAgentDefinitions,
  loadSkills,
  loadSkillsDetailed,
  listPlugins,
  removePlugin,
  removeSkill,
  readSkillEffectiveness,
  repairSkills,
  resolveSkillsStoreRoot,
  seekforgeHome,
  setEvolutionProposalStatus,
  setSkillEnabled,
  setPluginEnabled,
  SessionBusyError,
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

async function routes({ req, res, url, method, segs, workspace, rest }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/plugins") {
    return sendJson(res, 200, listPlugins(workspace));
  }

  if (method === "POST" && path === "/api/plugins") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must be {id: string}");
    }
    try {
      const result = await rest.coordinator.withRepository(workspace, async () => {
        return createPluginScaffold(workspace, id.trim());
      });
      return sendJson(res, 201, result);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot create a plugin while the workspace is active");
      }
      return sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "POST" && path === "/api/plugins/install") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { path: source, force } = (body ?? {}) as { path?: unknown; force?: unknown };
    if (typeof source !== "string" || source.trim() === "" || (force !== undefined && typeof force !== "boolean")) {
      return sendApiError(res, 400, "bad_request", "body must be {path: string, force?: boolean}");
    }
    try {
      return sendJson(res, 200, installPlugin(source, { force: force === true }));
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "another plugin mutation is active");
      }
      return sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "PUT" && segs.length === 3 && segs[1] === "plugins") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return sendApiError(res, 400, "bad_request", "body must be {enabled: boolean}");
    try {
      return sendJson(res, 200, setPluginEnabled(segs[2]!, enabled));
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "another plugin mutation is active");
      }
      return sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "DELETE" && segs.length === 3 && segs[1] === "plugins") {
    try {
      return sendJson(res, 200, removePlugin(segs[2]!));
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "another plugin mutation is active");
      }
      return sendApiError(res, 404, "not_found", error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "GET" && path === "/api/skills") {
    return sendJson(
      res,
      200,
      loadSkills(workspace).map(({ content: _content, ...rest }) => rest),
    );
  }

  if (method === "GET" && path === "/api/skills/diagnostics") {
    return sendJson(res, 200, { diagnostics: loadSkillsDetailed(workspace).diagnostics });
  }

  if (method === "GET" && path === "/api/skills/stats") {
    return sendJson(res, 200, { stats: readSkillEffectiveness(workspace) });
  }

  if (method === "POST" && path === "/api/skills/repair") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { global, id } = (body ?? {}) as { global?: unknown; id?: unknown };
    if ((global !== undefined && typeof global !== "boolean") || (id !== undefined && typeof id !== "string")) {
      return sendApiError(res, 400, "bad_request", "body must be {global?: boolean, id?: string}");
    }
    try {
      const mutate = async () => repairSkills(workspace, { global: global === true, ...(id ? { id } : {}) });
      const result = global === true ? await mutate() : await rest.coordinator.withRepository(workspace, mutate);
      return sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot repair skills while the workspace is active");
      }
      return sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
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
    try {
      const mutate = async () => {
        const targetRoot = resolveSkillsStoreRoot(global === true ? seekforgeHome() : workspace, true)!;
        return importExternalSkill(src, { targetRoot, guardWorkspace: workspace, global: global === true });
      };
      const { dir, skill } =
        global === true ? await mutate() : await rest.coordinator.withRepository(workspace, mutate);
      return sendJson(res, 200, { ok: true, dir, skill });
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot import a skill while the workspace is active");
      }
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
      const dir = await rest.coordinator.withRepository(workspace, async () => createSkillScaffold(workspace, id));
      return sendJson(res, 200, { ok: true, dir });
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot create a skill while the workspace is active");
      }
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
      return sendApiError(res, 400, "bad_request", 'body must be {enabled: boolean, scope?: "project"|"global"}');
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
      const mutate = async () => setSkillEnabled(workspace, id, enabled, { global });
      const result = global ? await mutate() : await rest.coordinator.withRepository(workspace, mutate);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot update a skill while the workspace is active");
      }
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
      const global = scope === "global";
      const mutate = async () => removeSkill(workspace, id, { global });
      const result = global ? await mutate() : await rest.coordinator.withRepository(workspace, mutate);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return sendApiError(res, 409, "session_busy", "cannot remove a skill while the workspace is active");
      }
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
      global === true ? join(seekforgeHome(), ".seekforge", "agents") : join(workspace, ".seekforge", "agents");
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
      const proposal = setEvolutionProposalStatus(workspace, id, segs[3] === "accept" ? "accepted" : "rejected");
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
