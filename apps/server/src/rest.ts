/**
 * REST endpoints under /api (SERVER-API.md). All responses are JSON;
 * errors are {error: {code, message}} with an appropriate HTTP status.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import {
  addMemoryFact,
  applyProposal,
  approveMemoryCandidate,
  BUILTIN_SKILLS,
  compactProjectMemory,
  createDefaultDispatcher,
  createMcpClient,
  createSkillScaffold,
  deleteSession,
  expandShellInjections,
  expandUserCommand,
  fetchBalance,
  importExternalAgent,
  importExternalSkill,
  listOutputStyles,
  loadUserCommands,
  compactSessionNow,
  listEvolutionProposals,
  memoryStats,
  pruneSessions,
  removeSkill,
  setSkillEnabled,
  listMcpPrompts,
  listMcpResources,
  listMemoryCandidates,
  listProjectFacts,
  listSessions,
  loadAgentDefinitions,
  loadSessionMessages,
  loadSkills,
  readCheckpoints,
  readFactMeta,
  readProjectMemory,
  readSessionMeta,
  rejectMemoryCandidate,
  removeProjectFact,
  rewindSession,
  rewindSessionToTurn,
  setEvolutionProposalStatus,
  truncateSessionAtUserTurn,
  MEMORY_CANDIDATE_TYPES,
  type HookConfig,
  type HookEntry,
  type McpClientEntry,
  type McpServerConfig,
  type MemoryCandidateType,
  DEFAULT_MODEL,
  DEPRECATED_MODELS,
  MODEL_PRICING,
} from "@seekforge/core";
import { ConfigValueError, loadConfig, maskedConfig, setConfigValue } from "./config.js";
import {
  FileBrowseError,
  listTree,
  listWorkspaceFiles,
  readRawUpload,
  readTextFile,
  writeTextFile,
  RawFileError,
  saveUpload,
  UploadError,
} from "./files.js";
import { WorktreeError, type WorktreeManager } from "./worktrees.js";
import { addTodo, loadTodos, removeTodo, toggleTodo } from "./todos.js";
import { workspaceFor, type WorkspaceRegistry } from "./workspaces.js";
import { forgetRecent, isWorkspaceDir, loadRecents, rememberRecent } from "./recents.js";

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

/** Recent workspaces not already hosted (so the "open recent" menu has no dupes). */
function recentsView(registry: WorkspaceRegistry): Array<{ path: string; name: string }> {
  const hosted = new Set(registry.summary.map((w) => resolvePath(w.path)));
  return loadRecents()
    .filter((r) => !hosted.has(resolvePath(r.path)))
    .map(({ path, name }) => ({ path, name }));
}

export type ApprovedFact = {
  index: number;
  type: string | null;
  content: string;
  addedAt?: string;
  uses: number;
  lastUsedAt?: string;
};

/**
 * Approved project-memory facts joined with their lifecycle metadata.
 * Each fact bullet is `- [type] content`; fact-meta is keyed by the bullet
 * body (`[type] content`, i.e. the line without the leading `- `).
 */
function buildApprovedFacts(workspace: string): ApprovedFact[] {
  const meta = readFactMeta(workspace);
  return listProjectFacts(workspace).map(({ index, line }) => {
    const body = line.replace(/^-\s*/, "").trim();
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(body);
    const type = match ? match[1]! : null;
    const content = match ? match[2]! : body;
    const m = meta[body];
    return {
      index,
      type,
      content,
      addedAt: m?.addedAt,
      uses: m?.uses ?? 0,
      lastUsedAt: m?.lastUsedAt,
    };
  });
}

// One readonly dispatcher instance for GET /api/project.
const dispatcher = createDefaultDispatcher();

const execFileAsync = promisify(execFile);

/**
 * execFile options for git, forcing the C locale so stderr messages (e.g.
 * "not a git repository") are in English regardless of the host's language —
 * our notGit detection matches on those English strings.
 */
const GIT_EXEC = (cwd: string): { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv } => ({
  cwd,
  timeout: 30_000,
  maxBuffer: 10_000_000,
  env: { ...process.env, LC_ALL: "C", LANG: "C" },
});

/** Current git diff of the workspace (no shell; capped at 2 MB). */
async function gitDiff(
  workspace: string,
  staged: boolean,
): Promise<{ diff: string; truncated: boolean; notGit?: boolean }> {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  try {
    const { stdout } = await execFileAsync("git", args, GIT_EXEC(workspace));
    const MAX = 2_000_000;
    return stdout.length > MAX
      ? { diff: stdout.slice(0, MAX), truncated: true }
      : { diff: stdout, truncated: false };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? "";
    // A workspace that isn't a git repo is a normal, expected state (e.g. the
    // desktop hosting a plain folder) — report it as an empty, non-error result
    // so the UI shows a friendly "not a git repository" notice, not a red error.
    // (Git missing entirely, "spawn git ENOENT", stays a real error so the user
    // learns git isn't installed rather than seeing a misleading empty diff.)
    if (/not a git repository/i.test(stderr)) {
      return { diff: "", truncated: false, notGit: true };
    }
    throw new Error(`git diff failed: ${stderr.slice(0, 500)}`);
  }
}

type GitFileStatus = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
};

type GitStatusResult = {
  notGit?: boolean;
  branch: string;
  files: GitFileStatus[];
};

/** Maps a single porcelain status code letter to our coarse status enum. */
function mapStatusCode(code: string): GitFileStatus["status"] {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      // "M", "T", "U" and anything else collapse to "modified".
      return "modified";
  }
}

/**
 * Working-tree status of the workspace via `git status --porcelain=v1 -b`.
 * A non-repo (or git missing) is reported as {notGit:true, branch:"", files:[]}
 * — never thrown — mirroring gitDiff's notGit handling.
 */
async function gitStatus(workspace: string): Promise<GitStatusResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-b"], GIT_EXEC(workspace)));
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr ?? e.message ?? "";
    if (/not a git repository/i.test(stderr) || /spawn git ENOENT/i.test(stderr)) {
      return { notGit: true, branch: "", files: [] };
    }
    throw new Error(`git status failed: ${stderr.slice(0, 500)}`);
  }
  let branch = "";
  const files: GitFileStatus[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("## ")) {
      // "## main...origin/main [ahead 1]" or "## HEAD (no branch)".
      const rest = line.slice(3);
      branch = rest.split(/\.\.\.| /)[0] ?? "";
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let pathPart = line.slice(3);
    // Renames are "R  old -> new"; report the new path.
    if (pathPart.includes(" -> ")) pathPart = pathPart.split(" -> ")[1] ?? pathPart;
    if (x === "?" && y === "?") {
      files.push({ path: pathPart, status: "untracked", staged: false });
      continue;
    }
    // A path can be both staged (index, X) and unstaged (worktree, Y); emit
    // one entry per side so the UI can show staged/unstaged separately.
    if (x !== " " && x !== "?") {
      files.push({ path: pathPart, status: mapStatusCode(x), staged: true });
    }
    if (y !== " " && y !== "?") {
      files.push({ path: pathPart, status: mapStatusCode(y), staged: false });
    }
  }
  return { branch, files };
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

/** Skills shipped in-package are immutable: refuse to mutate/delete them. */
function isBuiltinSkill(id: string): boolean {
  return BUILTIN_SKILLS.some((s) => s.id === id);
}

type ConfigDoc = { mcpServers?: Record<string, McpServerConfig>; [k: string]: unknown };

/**
 * Read-merge-write the workspace .seekforge/config.json mcpServers map: applies
 * `mutate` to the current servers object and writes the file back (mode 0o600).
 * Other top-level keys are preserved; an empty mcpServers map is dropped.
 */
function mutateMcpServers(
  workspace: string,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): void {
  const path = join(workspace, ".seekforge", "config.json");
  let doc: ConfigDoc = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as ConfigDoc;
    } catch {
      doc = {};
    }
  }
  const servers = { ...(doc.mcpServers ?? {}) };
  mutate(servers);
  if (Object.keys(servers).length === 0) delete doc.mcpServers;
  else doc.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

/** Reads the project config.json (raw); returns {} on missing/invalid. */
function readConfigDoc(workspace: string): ConfigDoc {
  const path = join(workspace, ".seekforge", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigDoc;
  } catch {
    return {};
  }
}

const HOOK_STAGES = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
  "sessionEnd",
] as const;

/** Validates a hooks object from PUT /api/hooks into a clean HookConfig. */
function validateHooks(input: unknown): { hooks: HookConfig } | { error: string } {
  if (input === null || typeof input !== "object") return { error: "hooks must be an object" };
  const out: HookConfig = {};
  for (const [stage, entries] of Object.entries(input as Record<string, unknown>)) {
    if (!(HOOK_STAGES as readonly string[]).includes(stage)) {
      return { error: `unknown hook stage: ${stage}` };
    }
    if (!Array.isArray(entries)) return { error: `${stage} must be an array` };
    const list: HookEntry[] = [];
    for (const e of entries) {
      if (e === null || typeof e !== "object") return { error: `${stage} entries must be objects` };
      const { command, match, pattern } = e as Record<string, unknown>;
      if (typeof command !== "string" || command.trim() === "") {
        return { error: `${stage} entry needs a non-empty command` };
      }
      if (match !== undefined && typeof match !== "string") return { error: `${stage} match must be a string` };
      if (pattern !== undefined && typeof pattern !== "string") return { error: `${stage} pattern must be a string` };
      list.push({
        command,
        ...(match !== undefined && match !== "" ? { match } : {}),
        ...(pattern !== undefined && pattern !== "" ? { pattern } : {}),
      });
    }
    if (list.length > 0) out[stage as keyof HookConfig] = list;
  }
  return { hooks: out };
}

/** Writes the hooks block into the project config.json, preserving other keys. */
function writeHooks(workspace: string, hooks: HookConfig): void {
  const path = join(workspace, ".seekforge", "config.json");
  const doc = readConfigDoc(workspace);
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  else doc.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RestContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;
  // ["api", ...rest] — path params are URL-decoded per segment. Malformed
  // percent-encoding (e.g. "/api/%E0%A4%A") makes decodeURIComponent throw, so
  // guard it and answer 400 rather than rejecting before the try below.
  let segs: string[];
  try {
    segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return sendApiError(res, 400, "bad_request", "malformed URL path");
  }

  try {
    // Global routes (not scoped to a workspace).
    if (method === "GET" && path === "/api/health") {
      return sendJson(res, 200, {
        version: ctx.version,
        workspace: ctx.registry.default.path,
        workspaces: ctx.registry.summary,
      });
    }

    if (method === "GET" && path === "/api/models") {
      const models = Object.entries(MODEL_PRICING).map(([id, pricing]) => ({
        id,
        isDefault: id === DEFAULT_MODEL,
        deprecated: DEPRECATED_MODELS.includes(id as never),
        pricing,
      }));
      return sendJson(res, 200, models);
    }

    if (method === "GET" && path === "/api/workspaces") {
      return sendJson(res, 200, { workspaces: ctx.registry.summary, recents: recentsView(ctx.registry) });
    }

    // Open a folder as a workspace: register it (idempotent) and remember it.
    if (method === "POST" && path === "/api/workspaces") {
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw.trim() === "" ? {} : JSON.parse(raw);
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const p = (body as { path?: unknown }).path;
      if (typeof p !== "string" || p.trim() === "") {
        return sendApiError(res, 400, "bad_request", "body must be {path: string}");
      }
      if (!isWorkspaceDir(p)) {
        return sendApiError(res, 400, "bad_request", `not a directory: ${p}`);
      }
      const ws = workspaceFor(p);
      if (!ctx.registry.resolve(ws.id)) ctx.registry.register(ws);
      rememberRecent(ws.path);
      return sendJson(res, 200, {
        workspace: { id: ws.id, name: ws.name, path: ws.path },
        workspaces: ctx.registry.summary,
        recents: recentsView(ctx.registry),
      });
    }

    // Forget a recent path (does not touch hosting). Checked before :id below.
    if (method === "DELETE" && segs.length === 3 && segs[1] === "workspaces" && segs[2] === "recent") {
      const p = url.searchParams.get("path");
      if (!p) return sendApiError(res, 400, "bad_request", "missing ?path=");
      forgetRecent(p);
      return sendJson(res, 200, { workspaces: ctx.registry.summary, recents: recentsView(ctx.registry) });
    }

    // Stop hosting a workspace (the launch/default workspace cannot be removed).
    if (method === "DELETE" && segs.length === 3 && segs[1] === "workspaces") {
      // Worktrees register as `wt-<slug>` workspaces but own a git worktree +
      // branch on disk — unregistering here would orphan them. They must go
      // through the worktree merge/discard flow (DELETE /api/worktrees/:id).
      if (segs[2]!.startsWith("wt-")) {
        return sendApiError(res, 400, "bad_request", "use DELETE /api/worktrees/:id to remove a worktree");
      }
      try {
        ctx.registry.unregister(segs[2]!);
      } catch (e) {
        return sendApiError(res, 400, "bad_request", e instanceof Error ? e.message : String(e));
      }
      return sendJson(res, 200, { workspaces: ctx.registry.summary, recents: recentsView(ctx.registry) });
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

    // Prune old sessions. Checked before DELETE :id (and before GET :id) so
    // "prune" is never treated as a session id.
    if (method === "POST" && path === "/api/sessions/prune") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { olderThanDays, keepLast, dryRun } = (body ?? {}) as {
        olderThanDays?: unknown;
        keepLast?: unknown;
        dryRun?: unknown;
      };
      if (
        olderThanDays !== undefined &&
        (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays < 0)
      ) {
        return sendApiError(res, 400, "bad_request", "olderThanDays must be a non-negative number");
      }
      if (
        keepLast !== undefined &&
        (typeof keepLast !== "number" || !Number.isInteger(keepLast) || keepLast < 0)
      ) {
        return sendApiError(res, 400, "bad_request", "keepLast must be a non-negative integer");
      }
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        return sendApiError(res, 400, "bad_request", "dryRun must be a boolean");
      }
      return sendJson(
        res,
        200,
        pruneSessions(workspace, {
          ...(olderThanDays !== undefined ? { olderThanDays } : {}),
          ...(keepLast !== undefined ? { keepLast } : {}),
          ...(dryRun !== undefined ? { dryRun } : {}),
        }),
      );
    }

    // Manual compaction of a stored session (folds the middle into a digest).
    if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "compact") {
      const id = segs[2]!;
      if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
      if (!readSessionMeta(workspace, id)) {
        return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      }
      return sendJson(res, 200, compactSessionNow(workspace, id));
    }

    // Delete a single session directory.
    if (method === "DELETE" && segs.length === 3 && segs[1] === "sessions") {
      const id = segs[2]!;
      if (!isSafeId(id)) return sendApiError(res, 400, "bad_request", `invalid session id: ${id}`);
      const deleted = deleteSession(workspace, id);
      if (!deleted) return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      return sendJson(res, 200, { deleted });
    }

    if (method === "GET" && path === "/api/files") {
      // @ file picker index: ignore-aware scan, capped at 2000 paths.
      return sendJson(res, 200, listWorkspaceFiles(workspace, url.searchParams.get("q") ?? ""));
    }

    // File browser: one directory listing (dirs first then files, alphabetical;
    // .git/denylisted/dot-dirs and sensitive files hidden). ?path empty = root.
    if (method === "GET" && path === "/api/tree") {
      try {
        return sendJson(res, 200, listTree(workspace, url.searchParams.get("path") ?? ""));
      } catch (err) {
        if (err instanceof FileBrowseError) return sendApiError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    // File viewer/editor.
    if (method === "GET" && path === "/api/file") {
      try {
        return sendJson(res, 200, readTextFile(workspace, url.searchParams.get("path") ?? ""));
      } catch (err) {
        if (err instanceof FileBrowseError) return sendApiError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    if (method === "PUT" && path === "/api/file") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, 4_000_000));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { path: rel, content } = (body ?? {}) as { path?: unknown; content?: unknown };
      if (typeof rel !== "string" || rel.trim() === "" || typeof content !== "string") {
        return sendApiError(res, 400, "bad_request", "body must be {path: string, content: string}");
      }
      try {
        writeTextFile(workspace, rel, content);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof FileBrowseError) return sendApiError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    // Raw bytes of an agent-uploaded image (so the UI renders real <img>
    // thumbnails). Hard-confined to .seekforge/uploads/ — NOT a general
    // file-serving endpoint. See readRawUpload for the confinement rules.
    if (method === "GET" && path === "/api/raw") {
      try {
        const { data, contentType } = readRawUpload(workspace, url.searchParams.get("path") ?? "");
        res.writeHead(200, {
          "content-type": contentType,
          "content-length": String(data.length),
          // Uploads are immutable (unique stamped names) — safe to cache.
          "cache-control": "private, max-age=31536000, immutable",
        });
        res.end(data);
        return;
      } catch (err) {
        if (err instanceof RawFileError) return sendApiError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    if (method === "POST" && path === "/api/upload") {
      // 4MB decoded cap → base64 plus JSON wrapper stays under ~6MB raw body.
      let raw: string;
      try {
        raw = await readBody(req, 6_000_000);
      } catch {
        return sendApiError(res, 413, "too_large", "request body too large (4MB image cap)");
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { name, dataBase64 } = (body ?? {}) as { name?: unknown; dataBase64?: unknown };
      if (typeof name !== "string" || name === "" || typeof dataBase64 !== "string" || dataBase64 === "") {
        return sendApiError(res, 400, "bad_request", "body must be {name, dataBase64}");
      }
      try {
        return sendJson(res, 200, saveUpload(workspace, name, dataBase64));
      } catch (err) {
        if (err instanceof UploadError) return sendApiError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    if (method === "GET" && path === "/api/diff") {
      const staged = url.searchParams.get("staged") === "1";
      return sendJson(res, 200, await gitDiff(workspace, staged));
    }

    // Source control (git). A non-repo is a normal state ({notGit:true}).
    if (method === "GET" && path === "/api/git/status") {
      return sendJson(res, 200, await gitStatus(workspace));
    }

    if (
      method === "POST" &&
      segs.length === 3 &&
      segs[1] === "git" &&
      (segs[2] === "stage" || segs[2] === "unstage" || segs[2] === "discard")
    ) {
      const action = segs[2]!;
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { paths } = (body ?? {}) as { paths?: unknown };
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p !== "")) {
        return sendApiError(res, 400, "bad_request", "body must be {paths: non-empty string[]}");
      }
      const relPaths = paths as string[];
      try {
        if (action === "stage") {
          await execFileAsync("git", ["add", "--", ...relPaths], GIT_EXEC(workspace));
        } else if (action === "unstage") {
          await execFileAsync("git", ["restore", "--staged", "--", ...relPaths], GIT_EXEC(workspace));
        } else {
          // discard: tracked changes via `git restore`; untracked files removed.
          // Determine which of the given paths are untracked, then handle both.
          const { stdout } = await execFileAsync(
            "git",
            // core.quotepath=false: don't octal-escape non-ASCII filenames, so
            // the untracked-path match below works for e.g. Chinese names.
            ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--", ...relPaths],
            GIT_EXEC(workspace),
          );
          const untracked = new Set<string>();
          for (const line of stdout.split("\n")) {
            if (line.startsWith("?? ")) untracked.add(line.slice(3));
          }
          const tracked = relPaths.filter((p) => !untracked.has(p));
          if (tracked.length > 0) {
            await execFileAsync("git", ["restore", "--", ...tracked], GIT_EXEC(workspace));
          }
          for (const p of relPaths) {
            if (!untracked.has(p)) continue;
            // Only remove a file that resolves inside the workspace (no traversal).
            const resolved = resolvePath(workspace, p);
            const wsResolved = resolvePath(workspace);
            if (resolved === wsResolved || !resolved.startsWith(wsResolved + sep)) {
              return sendApiError(res, 400, "bad_request", `path escapes the workspace: ${p}`);
            }
            rmSync(resolved, { force: true, recursive: true });
          }
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const stderr = e.stderr ?? e.message ?? "";
        return sendApiError(res, 400, "bad_request", `git ${action} failed: ${stderr.slice(0, 500)}`);
      }
    }

    if (method === "POST" && path === "/api/git/commit") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { message: msg } = (body ?? {}) as { message?: unknown };
      if (typeof msg !== "string" || msg.trim() === "") {
        return sendApiError(res, 400, "bad_request", "commit message must be a non-empty string");
      }
      // Refuse to commit when nothing is staged (git would error anyway, but a
      // clear 400 is friendlier than a raw git failure).
      const status = await gitStatus(workspace);
      if (status.notGit) {
        return sendApiError(res, 400, "bad_request", "not a git repository");
      }
      if (!status.files.some((f) => f.staged)) {
        return sendApiError(res, 400, "bad_request", "nothing staged to commit");
      }
      try {
        await execFileAsync("git", ["commit", "-m", msg], GIT_EXEC(workspace));
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], GIT_EXEC(workspace));
        return sendJson(res, 200, { ok: true, commit: stdout.trim() });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const stderr = e.stderr ?? e.message ?? "";
        return sendApiError(res, 400, "bad_request", `git commit failed: ${stderr.slice(0, 500)}`);
      }
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

    // User-turn index of a session: every role:"user" message in file order,
    // numbered 0..N-1 — the SAME all-user-messages indexing that
    // truncateSessionAtUserTurn / rewindSessionToTurn use. Turn 0 (the
    // original task) is flagged not backtrackable: truncating before it
    // would empty the conversation.
    if (method === "GET" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "turns") {
      const id = segs[2]!;
      if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
        return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      }
      let messages: ReturnType<typeof loadSessionMessages> = [];
      try {
        messages = loadSessionMessages(workspace, id);
      } catch {
        // no messages.jsonl yet -> zero turns
      }
      const turns = messages
        .filter((m) => m.role === "user")
        .map((m, turn) => ({ turn, text: m.content, backtrackable: turn > 0 }));
      return sendJson(res, 200, turns);
    }

    if (method === "POST" && segs.length === 4 && segs[1] === "sessions" && segs[3] === "backtrack") {
      const id = segs[2]!;
      if (!isSafeId(id) || !readSessionMeta(workspace, id)) {
        return sendApiError(res, 404, "not_found", `session not found: ${id}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { turn, files } = (body ?? {}) as { turn?: unknown; files?: unknown };
      if (typeof turn !== "number" || !Number.isInteger(turn)) {
        return sendApiError(res, 400, "bad_request", "body must be {turn: integer, files?: boolean}");
      }
      // Truncating validates the turn index (null = turn 0 / out of range);
      // file checkpoints are restored only after that validation passed.
      const truncated = truncateSessionAtUserTurn(workspace, id, turn);
      if (truncated === null) {
        return sendApiError(res, 400, "bad_request", `turn ${turn} is not backtrackable (turn 0 or out of range)`);
      }
      let filesResult: { restored: number; deleted: number; skipped: number } | null = null;
      if (files === true) {
        const r = rewindSessionToTurn(workspace, id, turn);
        filesResult = { restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length };
      }
      return sendJson(res, 200, { ...truncated, files: filesResult });
    }

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
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
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
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
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
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
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

    if (method === "GET" && path === "/api/memory") {
      return sendJson(res, 200, {
        projectMd: readProjectMemory(workspace) ?? null,
        candidates: listMemoryCandidates(workspace),
        facts: buildApprovedFacts(workspace),
      });
    }

    // Add an approved fact directly to project memory (CLI `memory add` parity).
    if (method === "POST" && path === "/api/memory/fact") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { content, type, pending, scope } = (body ?? {}) as {
        content?: unknown;
        type?: unknown;
        pending?: unknown;
        scope?: unknown;
      };
      if (typeof content !== "string" || content.trim() === "") {
        return sendApiError(res, 400, "bad_request", "content must be a non-empty string");
      }
      if (type !== undefined && !MEMORY_CANDIDATE_TYPES.includes(type as MemoryCandidateType)) {
        return sendApiError(
          res,
          400,
          "bad_request",
          `type must be one of: ${MEMORY_CANDIDATE_TYPES.join(", ")}`,
        );
      }
      if (pending !== undefined && typeof pending !== "boolean") {
        return sendApiError(res, 400, "bad_request", "pending must be a boolean");
      }
      if (scope !== undefined && scope !== "project" && scope !== "user") {
        return sendApiError(res, 400, "bad_request", 'scope must be "project" or "user"');
      }
      try {
        const created = addMemoryFact(workspace, {
          content,
          ...(type !== undefined ? { type: type as MemoryCandidateType } : {}),
          // `pending: true` queues the fact instead of writing it to project.md.
          approve: pending === true ? false : true,
          ...(scope === "user" ? { scope: "user" as const } : {}),
        });
        return sendJson(res, 201, created);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return sendApiError(res, 400, "bad_request", message);
      }
    }

    // Remove an approved fact from project memory, by index or by match.
    if (method === "DELETE" && path === "/api/memory/fact") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { index, match } = (body ?? {}) as { index?: unknown; match?: unknown };
      const hasIndex = typeof index === "number" && Number.isInteger(index);
      const hasMatch = typeof match === "string" && match.trim() !== "";
      if (hasIndex === hasMatch) {
        return sendApiError(
          res,
          400,
          "bad_request",
          "provide exactly one of: index (integer) or match (non-empty string)",
        );
      }
      try {
        const removed = hasIndex
          ? removeProjectFact(workspace, { index: index as number })
          : removeProjectFact(workspace, { match: match as string });
        return sendJson(res, 200, { removed });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // No-such-fact / ambiguous-match are client errors, not 500s.
        return sendApiError(res, 400, "bad_request", message);
      }
    }

    // Read-only extraction-quality stats for the workspace's memory state.
    if (method === "GET" && path === "/api/memory/stats") {
      return sendJson(res, 200, memoryStats(workspace));
    }

    // Deterministic project-memory compaction (dedupe/merge, optional prune).
    if (method === "POST" && path === "/api/memory/compact") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { dryRun, pruneUnusedDays } = (body ?? {}) as {
        dryRun?: unknown;
        pruneUnusedDays?: unknown;
      };
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        return sendApiError(res, 400, "bad_request", "dryRun must be a boolean");
      }
      if (
        pruneUnusedDays !== undefined &&
        (typeof pruneUnusedDays !== "number" || !Number.isFinite(pruneUnusedDays) || pruneUnusedDays < 0)
      ) {
        return sendApiError(res, 400, "bad_request", "pruneUnusedDays must be a non-negative number");
      }
      return sendJson(
        res,
        200,
        compactProjectMemory(workspace, {
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(pruneUnusedDays !== undefined ? { pruneUnusedDays } : {}),
        }),
      );
    }

    if (
      method === "POST" &&
      segs.length === 4 &&
      segs[1] === "memory" &&
      (segs[3] === "approve" || segs[3] === "reject")
    ) {
      const id = segs[2]!;
      const approveScope = url.searchParams.get("scope") === "user" ? "user" : "project";
      try {
        const candidate =
          segs[3] === "approve"
            ? approveMemoryCandidate(workspace, id, approveScope)
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

    // Import an external (Meta_Kim-style) agent .md. Checked before the
    // GET-by-id route so :id never captures "import".
    if (method === "POST" && segs.length === 3 && segs[1] === "agents" && segs[2] === "import") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
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

    // Custom user-defined slash commands (project + user layers; project wins).
    if (method === "GET" && path === "/api/commands") {
      return sendJson(res, 200, { commands: loadUserCommands(workspace) });
    }

    // Output styles: built-ins + custom .seekforge/output-styles/*.md files.
    if (method === "GET" && path === "/api/output-styles") {
      return sendJson(res, 200, { styles: listOutputStyles(workspace) });
    }

    // Expand a custom command server-side: interpolate args ($ARGUMENTS / $1..$9)
    // and run any !`shell` injections in the workspace, returning the final text.
    if (method === "POST" && path === "/api/commands/expand") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { name, args } = (body ?? {}) as { name?: unknown; args?: unknown };
      if (typeof name !== "string" || name === "") {
        return sendApiError(res, 400, "bad_request", "name must be a non-empty string");
      }
      const command = loadUserCommands(workspace).find((c) => c.name === name);
      if (!command) {
        return sendApiError(res, 404, "not_found", `unknown command: ${name}`);
      }
      const expanded = expandUserCommand(command, typeof args === "string" ? args : "");
      const text = await expandShellInjections(expanded, (cmd) =>
        execFileAsync("/bin/sh", ["-c", cmd], { cwd: workspace, timeout: 10_000, maxBuffer: 1024 * 1024 })
          .then(({ stdout }) => stdout)
          .catch((err: NodeJS.ErrnoException & { stdout?: string }) =>
            typeof err.stdout === "string" ? err.stdout : Promise.reject(err),
          ),
      );
      return sendJson(res, 200, { text });
    }

    // Cross-session todo list (.seekforge/todos.md, TUI-compatible format).
    if (method === "GET" && path === "/api/todos") {
      return sendJson(res, 200, loadTodos(workspace));
    }

    if (method === "POST" && path === "/api/todos") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { op, text, index } = (body ?? {}) as { op?: unknown; text?: unknown; index?: unknown };
      if (op === "add") {
        if (typeof text !== "string" || text.trim() === "") {
          return sendApiError(res, 400, "bad_request", 'op "add" needs a non-empty text');
        }
        addTodo(workspace, text.trim());
      } else if (op === "toggle" || op === "remove") {
        if (typeof index !== "number" || !Number.isInteger(index)) {
          return sendApiError(res, 400, "bad_request", `op "${op}" needs an integer index (1-based)`);
        }
        const result = op === "toggle" ? toggleTodo(workspace, index) : removeTodo(workspace, index);
        if (result === null) {
          return sendApiError(res, 404, "not_found", `no todo at index ${index}`);
        }
      } else {
        return sendApiError(res, 400, "bad_request", 'op must be "add", "toggle" or "remove"');
      }
      // Every mutation returns the updated list (what the UI re-renders).
      return sendJson(res, 200, loadTodos(workspace));
    }

    // DeepSeek account balance via the server's key. Null-safe by contract:
    // missing key or any fetch failure -> {balance: null}, never an error.
    if (method === "GET" && path === "/api/balance") {
      const config = loadConfig(workspace);
      const balance = config.apiKey ? await fetchBalance(config.apiKey, config.baseUrl) : null;
      return sendJson(res, 200, { balance });
    }

    // Resources of every configured MCP server (resources/list), spawned on
    // demand like POST /api/mcp/:name/tools. A server that fails or lacks
    // resource support contributes zero entries (listMcpResources never throws).
    if (method === "GET" && path === "/api/mcp/resources") {
      const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
      const entries: McpClientEntry[] = servers.map(([serverName, config]) => ({
        serverName,
        client: createMcpClient({ name: serverName, config, workspaceRoots: [workspace] }),
        trusted: config.trusted === true,
      }));
      try {
        return sendJson(res, 200, { resources: await listMcpResources(entries) });
      } finally {
        for (const e of entries) e.client.dispose();
      }
    }

    // Prompts of every configured MCP server (prompts/list), spawned on
    // demand. Mirrors /api/mcp/resources: a server that fails or lacks prompt
    // support contributes zero entries (listMcpPrompts never throws).
    if (method === "GET" && path === "/api/mcp/prompts") {
      const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
      const entries: McpClientEntry[] = servers.map(([serverName, config]) => ({
        serverName,
        client: createMcpClient({ name: serverName, config, workspaceRoots: [workspace] }),
        trusted: config.trusted === true,
      }));
      try {
        return sendJson(res, 200, { prompts: await listMcpPrompts(entries) });
      } finally {
        for (const e of entries) e.client.dispose();
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

    // Add or update an MCP server in the workspace config.json.
    if (method === "POST" && path === "/api/mcp") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const { name, command, args, env, url: serverUrl, headers, trusted } = (body ?? {}) as {
        name?: unknown;
        command?: unknown;
        args?: unknown;
        env?: unknown;
        url?: unknown;
        headers?: unknown;
        trusted?: unknown;
      };
      if (typeof name !== "string" || name.trim() === "") {
        return sendApiError(res, 400, "bad_request", "body must include a non-empty name");
      }
      if (command !== undefined && typeof command !== "string") {
        return sendApiError(res, 400, "bad_request", "command must be a string");
      }
      if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
        return sendApiError(res, 400, "bad_request", "args must be a string[]");
      }
      if (serverUrl !== undefined && typeof serverUrl !== "string") {
        return sendApiError(res, 400, "bad_request", "url must be a string");
      }
      if (trusted !== undefined && typeof trusted !== "boolean") {
        return sendApiError(res, 400, "bad_request", "trusted must be a boolean");
      }
      if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) {
        return sendApiError(res, 400, "bad_request", "env must be an object");
      }
      if (headers !== undefined && (typeof headers !== "object" || headers === null || Array.isArray(headers))) {
        return sendApiError(res, 400, "bad_request", "headers must be an object");
      }
      // Need at least a transport: command (stdio) or url (HTTP).
      if (typeof command !== "string" && typeof serverUrl !== "string") {
        return sendApiError(res, 400, "bad_request", "provide either command (stdio) or url (HTTP)");
      }
      const entry: McpServerConfig = {
        ...(typeof command === "string" ? { command } : {}),
        ...(Array.isArray(args) && args.length > 0 ? { args: args as string[] } : {}),
        ...(env !== undefined ? { env: env as Record<string, string> } : {}),
        ...(typeof serverUrl === "string" ? { url: serverUrl } : {}),
        ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
        ...(trusted !== undefined ? { trusted } : {}),
      };
      mutateMcpServers(workspace, (servers) => {
        servers[name] = entry;
      });
      return sendJson(res, 200, { ok: true });
    }

    // Remove an MCP server from the workspace config.json.
    if (method === "DELETE" && segs.length === 3 && segs[1] === "mcp") {
      const name = segs[2]!;
      const config = loadConfig(workspace).mcpServers ?? {};
      if (!config[name]) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
      mutateMcpServers(workspace, (servers) => {
        delete servers[name];
      });
      return sendJson(res, 200, { ok: true });
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

    // Lightweight environment/health check for the desktop diagnostics panel.
    if (method === "GET" && path === "/api/doctor") {
      const config = loadConfig(workspace);
      let git: string | null = null;
      try {
        const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5_000 });
        git = stdout.trim();
      } catch {
        // git not installed (ENOENT) or any failure → null
        git = null;
      }
      const runtimeBin = config.runtimeBin;
      return sendJson(res, 200, {
        apiKeyConfigured: Boolean(config.apiKey),
        nodeVersion: process.version,
        git,
        runtimeBin: {
          set: Boolean(runtimeBin),
          exists: runtimeBin ? existsSync(runtimeBin) : false,
        },
        mcpServerCount: Object.keys(config.mcpServers ?? {}).length,
        modelCount: Object.keys(MODEL_PRICING).length,
        workspace,
      });
    }

    if (method === "GET" && path === "/api/config") {
      return sendJson(res, 200, maskedConfig(workspace));
    }

    // Project hooks (the editable layer): read/write .seekforge/config.json hooks.
    if (method === "GET" && path === "/api/hooks") {
      return sendJson(res, 200, { hooks: readConfigDoc(workspace).hooks ?? {} });
    }
    if (method === "PUT" && path === "/api/hooks") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendApiError(res, 400, "bad_request", "body must be valid JSON");
      }
      const hooksInput =
        body !== null && typeof body === "object" ? (body as { hooks?: unknown }).hooks : undefined;
      const result = validateHooks(hooksInput);
      if ("error" in result) {
        return sendApiError(res, 400, "bad_request", result.error);
      }
      writeHooks(workspace, result.hooks);
      return sendJson(res, 200, { hooks: result.hooks });
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
