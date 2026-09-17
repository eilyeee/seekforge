import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireSessionLease } from "../agent/session-lease.js";
import { seekforgeHome } from "../memory/store.js";
import { readFileIfExists, writeFileAtomic } from "../util/fs.js";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { mcpTransportOf } from "./launch.js";
import type { McpServerConfig, McpTransportKind } from "./types.js";

/**
 * The user's decisions about servers a checkout defines.
 *
 * A repository layer (`.seekforge/config.json`, `config.local.json`, `.mcp.json`)
 * may name servers but can never mark them trusted: connecting one starts a
 * process or contacts an endpoint the checkout chose. Approval is how the user
 * vouches for one anyway. It is recorded here — under the SeekForge home, which
 * no checkout can write — keyed by the workspace AND a digest of the definition
 * exactly as it reads (references unexpanded). Edit the definition and the
 * approval no longer matches: the server is pending again until the user looks
 * at the new one.
 */

export type ProjectMcpDecision = "approved" | "rejected";
export type ProjectMcpServerStatus = ProjectMcpDecision | "pending";

type DecisionRecord = { digest: string; decision: ProjectMcpDecision; decidedAt: string };
type DecisionFile = { version: 1; workspaces: Map<string, Map<string, DecisionRecord>> };

const MAX_STORE_BYTES = 1024 * 1024;
const MAX_WORKSPACES = 512;
const MAX_SERVERS_PER_WORKSPACE = 256;
const MAX_NAME_CHARS = 256;
const LEASE_ID = "mcp-project-approvals";
const DIGEST_RE = /^[a-f0-9]{64}$/;

export function projectMcpApprovalsPath(): string {
  return join(seekforgeHome(), ".seekforge", "mcp-project-approvals.json");
}

/** The same folder written two ways (a symlink, a trailing slash) is one workspace. */
function workspaceKey(workspace: string): string {
  try {
    return realpathSync.native(workspace);
  } catch {
    return resolve(workspace);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  }
  return out;
}

/**
 * sha256 over the definition with keys sorted and `trusted` left out (a
 * repository layer has it stripped before anyone sees the entry, so it is not
 * part of what the user approves). Every other field counts, including ones
 * this version does not understand.
 */
export function mcpServerDigest(config: McpServerConfig | Record<string, unknown>): string {
  const { trusted: _trusted, ...rest } = config as Record<string, unknown>;
  return createHash("sha256")
    .update(JSON.stringify(canonical(rest)))
    .digest("hex");
}

/** The definition as a person should review it: unexpanded, trust flag omitted, stable key order. */
export function formatMcpServerDefinition(config: McpServerConfig | Record<string, unknown>): string {
  const { trusted: _trusted, ...rest } = config as Record<string, unknown>;
  return JSON.stringify(canonical(rest), null, 2);
}

function parseRecord(value: unknown): DecisionRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["digest", "decision", "decidedAt"])) return undefined;
  if (typeof value.digest !== "string" || !DIGEST_RE.test(value.digest)) return undefined;
  if (value.decision !== "approved" && value.decision !== "rejected") return undefined;
  if (typeof value.decidedAt !== "string" || Number.isNaN(Date.parse(value.decidedAt))) return undefined;
  return { digest: value.digest, decision: value.decision, decidedAt: value.decidedAt };
}

function readStore(): DecisionFile {
  const empty: DecisionFile = { version: 1, workspaces: new Map() };
  const raw = readFileIfExists(projectMcpApprovalsPath(), MAX_STORE_BYTES);
  if (raw === undefined) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // A corrupt store forgets every decision, which fails closed: approved
    // servers go back to pending, nothing becomes approved.
    return empty;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.workspaces)) return empty;
  for (const [workspace, servers] of Object.entries(parsed.workspaces)) {
    if (!isRecord(servers)) continue;
    const decisions = new Map<string, DecisionRecord>();
    for (const [name, value] of Object.entries(servers)) {
      const record = parseRecord(value);
      if (record && name.length > 0 && name.length <= MAX_NAME_CHARS) decisions.set(name, record);
    }
    if (decisions.size > 0) empty.workspaces.set(workspace, decisions);
  }
  return empty;
}

function latest(decisions: Map<string, DecisionRecord>): number {
  let newest = 0;
  for (const record of decisions.values()) newest = Math.max(newest, Date.parse(record.decidedAt));
  return newest;
}

function writeStore(file: DecisionFile): void {
  let workspaces = [...file.workspaces.entries()];
  if (workspaces.length > MAX_WORKSPACES) {
    workspaces = workspaces.sort((a, b) => latest(b[1]) - latest(a[1])).slice(0, MAX_WORKSPACES);
  }
  const serialized: Record<string, Record<string, DecisionRecord>> = {};
  for (const [workspace, decisions] of workspaces) {
    // Null prototype: a server literally named "__proto__" stays a data key.
    const servers = Object.create(null) as Record<string, DecisionRecord>;
    for (const [name, record] of decisions) servers[name] = record;
    serialized[workspace] = servers;
  }
  const path = projectMcpApprovalsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify({ version: 1, workspaces: serialized }, null, 2)}\n`);
  chmodSync(path, 0o600);
}

function mutate<T>(action: (file: DecisionFile) => T): T {
  const lease = acquireSessionLease(seekforgeHome(), LEASE_ID);
  try {
    const file = readStore();
    const result = action(file);
    writeStore(file);
    return result;
  } finally {
    lease.release();
  }
}

function requireName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_CHARS) {
    throw new RangeError(`invalid MCP server name ${JSON.stringify(name)}`);
  }
}

function decide(
  workspace: string,
  name: string,
  config: McpServerConfig | Record<string, unknown>,
  decision: ProjectMcpDecision,
): void {
  requireName(name);
  if (!isRecord(config)) throw new TypeError(`MCP server "${name}" has no definition to decide on`);
  const digest = mcpServerDigest(config);
  const key = workspaceKey(workspace);
  mutate((file) => {
    const decisions = file.workspaces.get(key) ?? new Map<string, DecisionRecord>();
    decisions.set(name, { digest, decision, decidedAt: new Date().toISOString() });
    if (decisions.size > MAX_SERVERS_PER_WORKSPACE) {
      const oldest = [...decisions.entries()].sort((a, b) => Date.parse(a[1].decidedAt) - Date.parse(b[1].decidedAt));
      for (const [stale] of oldest.slice(0, decisions.size - MAX_SERVERS_PER_WORKSPACE)) decisions.delete(stale);
    }
    file.workspaces.set(key, decisions);
  });
}

/** Records that the user approved this exact definition of `name` for `workspace`. */
export function approveProjectMcpServer(
  workspace: string,
  name: string,
  config: McpServerConfig | Record<string, unknown>,
): void {
  decide(workspace, name, config, "approved");
}

/** Records that the user declined this exact definition; it stays unconnected and stops being "pending". */
export function rejectProjectMcpServer(
  workspace: string,
  name: string,
  config: McpServerConfig | Record<string, unknown>,
): void {
  decide(workspace, name, config, "rejected");
}

/** Forgets every decision for `workspace`; returns how many were dropped. */
export function resetProjectMcpChoices(workspace: string): number {
  const key = workspaceKey(workspace);
  return mutate((file) => {
    const removed = file.workspaces.get(key)?.size ?? 0;
    file.workspaces.delete(key);
    return removed;
  });
}

/** `approved`/`rejected` only while the recorded digest still matches the definition. */
export function projectMcpServerStatus(
  workspace: string,
  name: string,
  config: McpServerConfig | Record<string, unknown>,
): ProjectMcpServerStatus {
  if (!isRecord(config)) return "pending";
  const record = readStore().workspaces.get(workspaceKey(workspace))?.get(name);
  if (!record || record.digest !== mcpServerDigest(config)) return "pending";
  return record.decision;
}

export type ProjectMcpServer = {
  name: string;
  status: ProjectMcpServerStatus;
  /** Transport the definition selects, or "invalid" when it names an unknown `type`. */
  transport: McpTransportKind | "invalid";
  digest: string;
  /** The definition exactly as the repository wrote it (after the layer reduction). */
  config: McpServerConfig;
};

/**
 * Every repository-owned server in a merged config and the user's standing
 * decision on it. `origins` is the merge report's `mcpServerOrigins`; names it
 * does not mark as `repository` are the user's own and are not listed. Reads
 * the store once and never connects anything.
 */
export function listProjectMcpServers(
  workspace: string,
  servers: Record<string, unknown> | undefined,
  origins: Record<string, "user" | "repository">,
): ProjectMcpServer[] {
  const decisions = readStore().workspaces.get(workspaceKey(workspace));
  const out: ProjectMcpServer[] = [];
  for (const [name, value] of Object.entries(servers ?? {})) {
    if (origins[name] !== "repository" || !isRecord(value)) continue;
    const config = value as McpServerConfig;
    const digest = mcpServerDigest(config);
    const record = decisions?.get(name);
    let transport: ProjectMcpServer["transport"];
    try {
      transport = mcpTransportOf(config);
    } catch {
      transport = "invalid";
    }
    out.push({
      name,
      status: record && record.digest === digest ? record.decision : "pending",
      transport,
      digest,
      config,
    });
  }
  return out;
}

/** The repository-owned servers still waiting for a decision. */
export function listPendingProjectMcpServers(
  workspace: string,
  servers: Record<string, unknown> | undefined,
  origins: Record<string, "user" | "repository">,
): ProjectMcpServer[] {
  return listProjectMcpServers(workspace, servers, origins).filter((server) => server.status === "pending");
}
