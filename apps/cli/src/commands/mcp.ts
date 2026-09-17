import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  acquireSessionLease,
  approveProjectMcpServer,
  createMcpClient,
  formatMcpServerDefinition,
  listProjectMcpServers,
  McpDefinitionError,
  mcpServerDigest,
  type McpServerConfig,
  mcpTransportOf,
  parseMcpEnvAssignment,
  parseMcpHeaderAssignment,
  parseMcpServerDefinition,
  rejectProjectMcpServer,
  resetProjectMcpChoices,
  validateMcpServerName,
} from "@seekforge/core";
import { GLOBAL_CONFIG_LOCK_ID, sanitizeProjectConfig } from "@seekforge/shared/config-layers";
import { dim, fail } from "../colors.js";
import { t } from "../i18n.js";
import { resolveConfig } from "../config.js";
import {
  addMcpServerEntry,
  collectMcpImportCandidates,
  ConfigParseError,
  type McpImportSource,
  type McpScope,
  mcpAddDefinition,
  mcpScopePath,
  readConfigDoc,
  removeMcpServer,
  resolveMcpScope,
  writeConfigDoc,
} from "../mcp-config.js";
import { ensureWorkspaceAuthorized } from "./run.js";

/** One line saying what a definition runs or contacts, unexpanded. */
function describeServer(config: McpServerConfig): string {
  let transport: string;
  try {
    transport = mcpTransportOf(config);
  } catch {
    return `invalid type ${JSON.stringify((config as { type?: unknown }).type)}`;
  }
  if (transport === "stdio") return [config.command, ...(config.args ?? [])].join(" ");
  return `${transport} ${config.url ?? ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a read-modify-write of one config file. The user file is shared with
 * every other SeekForge process (`config set --global`, TUI/Desktop "always
 * allow"), so it is edited under the same lease they take.
 */
function editConfig(
  path: string,
  scope: McpScope,
  edit: (doc: ReturnType<typeof readConfigDoc>) => ReturnType<typeof readConfigDoc>,
): boolean {
  let lease: { release: () => void } | undefined;
  if (scope === "user") {
    try {
      lease = acquireSessionLease(realpathSync(homedir()), GLOBAL_CONFIG_LOCK_ID);
    } catch {
      fail(t("err.configBusy"));
      return false;
    }
  }
  try {
    writeConfigDoc(path, edit(readConfigDoc(path)));
    return true;
  } catch (err) {
    if (err instanceof ConfigParseError) fail(t("err.mcpConfigInvalidJson", { path: err.path }));
    else fail(errorMessage(err));
    return false;
  } finally {
    lease?.release();
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `seekforge mcp list` — spawn each configured server, handshake, and list
 * its tool names. A failing server shows its error and the listing continues.
 *
 * Listing is not a read: every listed entry is started. An entry that came out
 * of the checkout (`.seekforge/config.json`, `config.local.json`, `.mcp.json`)
 * is a command the repository chose, so it is started only once the user has
 * approved that exact definition for this workspace — pending and rejected ones
 * are shown, never run. When any approved repository entry is about to start,
 * the command also takes the same folder-access consent `run`, `repl`, `loop`
 * and `graph` take (`-y` pre-authorizes). Servers from the user's own
 * global/`--settings` config need neither.
 */
export async function mcpListCommand(opts: { tools?: boolean; yes?: boolean }): Promise<void> {
  const projectPath = process.cwd();
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const servers = Object.entries(config.mcpServers ?? {});
  if (servers.length === 0) {
    console.log(t("cmd.mcp.none"));
    return;
  }
  const decisions = new Map(
    listProjectMcpServers(projectPath, config.mcpServers, mcpOrigins).map((server) => [server.name, server.status]),
  );
  const approvedRepositoryServer = servers.some(
    ([name]) => mcpOrigins[name] === "repository" && decisions.get(name) === "approved",
  );
  if (
    approvedRepositoryServer &&
    !(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine: false }))
  ) {
    return;
  }

  for (const [name, serverConfig] of servers) {
    const commandLine = describeServer(serverConfig);
    const fromRepository = mcpOrigins[name] === "repository";
    const decision = decisions.get(name) ?? "pending";
    if (fromRepository && decision !== "approved") {
      console.log(
        t(decision === "rejected" ? "cmd.mcp.rejectedLine" : "cmd.mcp.pendingLine", { name, cmd: commandLine }),
      );
      continue;
    }
    const trustLabel = fromRepository
      ? `${t("cmd.mcp.approved")}, ${t("cmd.mcp.fromRepository")}`
      : `${serverConfig.trusted ? t("cmd.mcp.trusted") : t("cmd.mcp.untrusted")}, ${t("cmd.mcp.fromUser")}`;
    // The user asked for exactly this; references expand as they would for a
    // connection the entry is entitled to.
    const client = createMcpClient({ name, config: serverConfig, trust: fromRepository ? "project" : "user" });
    try {
      const tools = await client.listTools();
      console.log(t("cmd.mcp.serverLine", { name, cmd: commandLine, trust: trustLabel, count: tools.length }));
      for (const tool of tools) {
        if (opts.tools) {
          const firstLine = (tool.description ?? "").split("\n")[0] ?? "";
          console.log(`  ${tool.name}  ${dim(firstLine)}`);
        } else {
          console.log(`  ${tool.name}`);
        }
      }
    } catch (err) {
      console.error(t("cmd.mcp.serverError", { name, cmd: commandLine, trust: trustLabel, error: errorMessage(err) }));
    } finally {
      client.dispose();
    }
  }
}

/** `seekforge mcp get <name>` — the definition and its standing. Starts nothing. */
export function mcpGetCommand(name: string): void {
  const projectPath = process.cwd();
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const server = config.mcpServers?.[name];
  if (!server) {
    fail(t("cmd.mcpLogin.unknownServer", { name }), { hint: t("cmd.mcpLogin.unknownServerHint") });
    return;
  }
  const fromRepository = mcpOrigins[name] === "repository";
  let status: string;
  if (fromRepository) {
    const decision =
      listProjectMcpServers(projectPath, { [name]: server }, { [name]: "repository" })[0]?.status ?? "pending";
    status =
      decision === "approved"
        ? t("cmd.mcp.statusProjectApproved")
        : decision === "rejected"
          ? t("cmd.mcp.statusProjectRejected")
          : t("cmd.mcp.statusProjectPending", { name });
  } else {
    status = server.trusted ? t("cmd.mcp.statusUserTrusted") : t("cmd.mcp.statusUserUntrusted");
  }
  let transport: string;
  try {
    transport = mcpTransportOf(server);
  } catch (error) {
    transport = errorMessage(error);
  }
  console.log(name);
  console.log(t("cmd.mcp.getSource", { source: fromRepository ? t("cmd.mcp.fromRepository") : t("cmd.mcp.fromUser") }));
  console.log(t("cmd.mcp.getStatus", { status }));
  console.log(t("cmd.mcp.getTransport", { transport }));
  console.log(t("cmd.mcp.getDefinition"));
  for (const line of formatMcpServerDefinition(server).split("\n")) console.log(`  ${line}`);
}

type AddOptions = {
  global?: boolean;
  scope?: string;
  transport?: string;
  env?: string[];
  header?: string[];
  trust?: boolean;
};

/**
 * Writes a validated definition to the chosen scope, then settles its trust:
 * `--trust` marks a user entry trusted, and approves a project/local entry for
 * this workspace — the approval covers the definition as the merged config
 * reads it, which is what the loader will compare against.
 */
function writeServer(name: string, entry: McpServerConfig, scope: McpScope, trust: boolean): void {
  const projectPath = process.cwd();
  const path = mcpScopePath(projectPath, scope);
  if (!editConfig(path, scope, (doc) => addMcpServerEntry(doc, name, entry))) return;
  console.log(t("status.addedMcp", { name, cmd: describeServer(entry), path }));
  if (scope === "user") {
    console.log(dim(entry.trusted ? t("cmd.mcp.addedTrusted") : t("cmd.mcp.addedUntrusted")));
    return;
  }
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const effective = config.mcpServers?.[name];
  if (mcpOrigins[name] !== "repository" || !effective) {
    console.log(t("cmd.mcp.addedShadowed", { name }));
    return;
  }
  if (!trust) {
    console.log(dim(t("cmd.mcp.addedPending", { name })));
    return;
  }
  // Approve only what this command wrote, as the repository layer reduces it —
  // never a different same-named entry from a higher-precedence project file.
  const written = sanitizeProjectConfig({ mcpServers: { [name]: entry } }).mcpServers?.[name];
  if (!written || mcpServerDigest(written as McpServerConfig) !== mcpServerDigest(effective)) {
    console.log(t("cmd.mcp.addedOverridden", { name }));
    return;
  }
  approveProjectMcpServer(projectPath, name, effective);
  console.log(dim(t("cmd.mcp.addedApproved")));
}

/**
 * `seekforge mcp add [options] <name> <command-or-url...>` — stdio by default
 * (the first token after <name> is the command, the rest its args);
 * `--transport http|sse` takes exactly one url. `--scope` picks the file
 * (default project; `-g` = user).
 */
export function mcpAddCommand(name: string, targetTokens: string[], opts: AddOptions): void {
  if (targetTokens.length === 0) {
    fail(t("err.missingCommandMcp"), { hint: t("err.missingCommandMcpHint") });
    return;
  }
  let scope: McpScope;
  let entry: McpServerConfig;
  let serverName: string;
  try {
    serverName = validateMcpServerName(name);
    scope = resolveMcpScope(opts);
    const transport = opts.transport ?? "stdio";
    if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
      throw new McpDefinitionError('--transport must be "stdio", "http" or "sse"');
    }
    entry = mcpAddDefinition({
      transport,
      target: targetTokens,
      env: (opts.env ?? []).map(parseMcpEnvAssignment),
      headers: (opts.header ?? []).map(parseMcpHeaderAssignment),
      trusted: scope === "user" && opts.trust === true,
    });
  } catch (error) {
    fail(errorMessage(error));
    return;
  }
  writeServer(serverName, entry, scope, opts.trust === true);
}

/** `seekforge mcp add-json <name> '<json>'` — one definition, Claude Code-compatible. */
export function mcpAddJsonCommand(
  name: string,
  json: string,
  opts: { global?: boolean; scope?: string; trust?: boolean },
): void {
  let scope: McpScope;
  let entry: McpServerConfig;
  let serverName: string;
  try {
    serverName = validateMcpServerName(name);
    scope = resolveMcpScope(opts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (error) {
      throw new McpDefinitionError(t("cmd.mcp.invalidJson", { error: errorMessage(error) }));
    }
    entry = parseMcpServerDefinition(parsed).config;
    if (entry.trusted !== undefined && scope !== "user") {
      throw new McpDefinitionError(t("cmd.mcp.projectTrusted", { scope }));
    }
    if (scope === "user" && opts.trust === true) entry = { ...entry, trusted: true };
  } catch (error) {
    fail(errorMessage(error));
    return;
  }
  writeServer(serverName, entry, scope, opts.trust === true);
}

/**
 * `seekforge mcp import [--from claude-desktop|claude-code]` — copies server
 * definitions from Claude Desktop and Claude Code into the user config.
 *
 * Imported entries are marked `trusted: true` unless `--no-trust` is given:
 * they come from the user's own configuration files, where they already ran,
 * and the command prints every definition before writing anything. `-y` skips
 * the confirmation, not the listing.
 */
export async function mcpImportCommand(opts: { from?: string; yes?: boolean; trust?: boolean }): Promise<void> {
  if (opts.from !== undefined && opts.from !== "claude-desktop" && opts.from !== "claude-code") {
    fail('--from must be "claude-desktop" or "claude-code"');
    return;
  }
  const projectPath = process.cwd();
  const home = homedir();
  const { candidates, problems, scanned } = collectMcpImportCandidates(opts.from as McpImportSource | undefined, {
    home,
    platform: process.platform,
    env: process.env,
    projectPath,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
  const path = mcpScopePath(projectPath, "user");
  let existing: Record<string, unknown>;
  try {
    const servers = readConfigDoc(path).mcpServers;
    existing = typeof servers === "object" && servers !== null ? servers : {};
  } catch (err) {
    fail(err instanceof ConfigParseError ? t("err.mcpConfigInvalidJson", { path: err.path }) : errorMessage(err));
    return;
  }
  if (candidates.length === 0 && problems.length === 0) {
    console.log(t("cmd.mcp.importNone", { paths: scanned.length > 0 ? scanned.join(", ") : "-" }));
    return;
  }
  const trust = opts.trust !== false;
  const fresh = candidates.filter((candidate) => !Object.hasOwn(existing, candidate.name));
  console.log(t("cmd.mcp.importHeader", { path }));
  for (const candidate of candidates) {
    if (!fresh.includes(candidate)) {
      console.log(t("cmd.mcp.importSkipExisting", { name: candidate.name }));
      continue;
    }
    console.log(
      t("cmd.mcp.importLine", {
        name: candidate.name,
        cmd: describeServer(candidate.config),
        source: candidate.source,
      }),
    );
    if (candidate.dropped.length > 0)
      console.log(dim(t("cmd.mcp.importDropped", { fields: candidate.dropped.join(", ") })));
  }
  for (const problem of problems) console.log(t("cmd.mcp.importProblem", problem));
  if (fresh.length === 0) {
    console.log(t("cmd.mcp.importNothingNew"));
    return;
  }
  console.log(dim(trust ? t("cmd.mcp.importTrustNote") : t("cmd.mcp.importUntrustNote")));
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      fail(t("cmd.mcp.importNeedsYes"));
      return;
    }
    if (!(await confirm(t("cmd.mcp.importPrompt", { count: fresh.length })))) {
      console.log(t("cmd.mcp.importCancelled"));
      return;
    }
  }
  let written = 0;
  const ok = editConfig(path, "user", (doc) => {
    let next = doc;
    written = 0;
    for (const candidate of fresh) {
      // Re-checked under the lease: another process may have added the name.
      if (next.mcpServers && Object.hasOwn(next.mcpServers, candidate.name)) continue;
      next = addMcpServerEntry(next, candidate.name, trust ? { ...candidate.config, trusted: true } : candidate.config);
      written++;
    }
    return next;
  });
  if (ok) console.log(t("cmd.mcp.importDone", { count: written, path }));
}

/** Finds a repository-defined server by name, or reports why it cannot be decided on. */
function repositoryServer(name: string): { projectPath: string; server: McpServerConfig } | undefined {
  const projectPath = process.cwd();
  const { config, mcpOrigins } = resolveConfig(projectPath);
  const server = config.mcpServers?.[name];
  if (!server) {
    fail(t("cmd.mcpLogin.unknownServer", { name }), { hint: t("cmd.mcpLogin.unknownServerHint") });
    return undefined;
  }
  if (mcpOrigins[name] !== "repository") {
    fail(t("cmd.mcp.notProjectServer", { name }));
    return undefined;
  }
  return { projectPath, server };
}

/**
 * `seekforge mcp approve <name>` — lets a repository-defined server connect
 * automatically in this workspace. The definition is printed exactly as written
 * (references unexpanded) and confirmed first unless `-y`.
 */
export async function mcpApproveCommand(name: string, opts: { yes?: boolean }): Promise<void> {
  const found = repositoryServer(name);
  if (!found) return;
  const { projectPath, server } = found;
  console.log(t("cmd.mcp.approveReview", { name, workspace: projectPath }));
  for (const line of formatMcpServerDefinition(server).split("\n")) console.log(`  ${line}`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      fail(t("cmd.mcp.approveNeedsYes"), { hint: t("cmd.mcp.approveNeedsYesHint", { name }) });
      return;
    }
    if (!(await confirm(t("cmd.mcp.approvePrompt")))) {
      console.log(t("cmd.mcp.approveDeclined"));
      return;
    }
  }
  try {
    approveProjectMcpServer(projectPath, name, server);
  } catch (error) {
    fail(errorMessage(error));
    return;
  }
  console.log(t("cmd.mcp.approvedDone", { name, workspace: projectPath }));
}

/** `seekforge mcp reject <name>` — records that this definition must not connect here. */
export function mcpRejectCommand(name: string): void {
  const found = repositoryServer(name);
  if (!found) return;
  try {
    rejectProjectMcpServer(found.projectPath, name, found.server);
  } catch (error) {
    fail(errorMessage(error));
    return;
  }
  console.log(t("cmd.mcp.rejectedDone", { name, workspace: found.projectPath }));
}

/** `seekforge mcp reset-project-choices` — forgets every approval and rejection for this workspace. */
export function mcpResetProjectChoicesCommand(): void {
  const projectPath = process.cwd();
  try {
    const count = resetProjectMcpChoices(projectPath);
    console.log(t("cmd.mcp.resetDone", { count, workspace: projectPath }));
  } catch (error) {
    fail(errorMessage(error));
  }
}

/**
 * `seekforge mcp remove <name>` — delete a server from the chosen scope
 * (default project; `-g` = user).
 */
export function mcpRemoveCommand(name: string, opts: { global?: boolean; scope?: string }): void {
  let scope: McpScope;
  try {
    scope = resolveMcpScope(opts);
  } catch (error) {
    fail(errorMessage(error));
    return;
  }
  const path = mcpScopePath(process.cwd(), scope);
  if (editConfig(path, scope, (doc) => removeMcpServer(doc, name))) {
    console.log(t("status.removedMcp", { name, path }));
  }
}
