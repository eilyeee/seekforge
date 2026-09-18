/**
 * Server-local config loading & writing.
 *
 * Mirrors apps/cli/src/config.ts and `seekforge config set` — apps/server must
 * not depend on apps/cli, so the small logic is replicated here.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  acquireSessionLease,
  DEPRECATED_MODELS,
  MODEL_PRICING,
  parseSandboxNetworkPolicy,
  type HookConfig,
  type LspServerConfig,
  type McpServerConfig,
  type MemoryMaintenanceConfig,
  type ModelPricing,
  resolveMemoryMaintenanceConfig,
} from "@seekforge/core";
import { type HookStage, type PermissionRule, REASONING_EFFORTS, type ReasoningEffort } from "@seekforge/shared";
import { GLOBAL_CONFIG_LOCK_ID } from "@seekforge/shared/config-layers";
import { readFileBounded, readFileDescriptorBounded } from "@seekforge/shared/bounded-file-read";
import {
  type ConfigLayerOrigin,
  describeConfigMergeReport,
  isProjectConfigKeyAllowed,
  MAX_CONFIG_FILE_BYTES,
  mergeConfigLayers,
  mergeConfigLayersWithReport,
  readJsonConfigLayer,
  readProjectMcpJsonLayer,
  repositoryConfigLayer,
  sanitizeProjectConfig,
  userConfigLayer,
} from "@seekforge/shared/config-layers";
import { normalizeExtraDir } from "@seekforge/shared/workspace-dirs";

export const MAX_PROJECT_STATE_FILE_BYTES = 8_000_000;

/** Default selectable model list (core's non-deprecated ids) when none configured. */
const DEFAULT_MODEL_LIST = Object.keys(MODEL_PRICING).filter(
  (id) => !(DEPRECATED_MODELS as readonly string[]).includes(id),
);

export type ServerConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** Selectable model ids offered in the UI pickers (your own list). */
  models?: string[];
  /**
   * User-supplied per-model price table (model id → { inputCacheMissPer1M,
   * inputCacheHitPer1M, outputPer1M } in USD per 1M tokens). Enables cost/budget
   * tracking on providers with no built-in price table (Ark, OpenAI, …); without
   * it cost stays 0 there. Edit the file directly; not settable via `config set`.
   */
  modelPricing?: Record<string, ModelPricing>;
  /**
   * Whether images travel inline to the model (a screenshot attached to the tool
   * result that produced it). Unset follows the provider preset. Edit the file
   * directly; not settable via `config set`.
   */
  inlineImages?: boolean;
  /** OS-level command sandbox (off when unset). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  /** Domain allowlist for sandboxed commands (user-owned; core validates it). */
  sandboxNetwork?: { allowedDomains: string[]; deniedDomains?: string[] };
  /** Directories outside the project the file tools may also use (user-owned). */
  additionalDirectories?: string[];
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** Fraction (0, 1] of the context budget at which compaction starts (default 0.9). User-owned. */
  autoCompactThreshold?: number;
  /** Context-window overrides in tokens, keyed by exact model id. User-owned. */
  modelContextWindows?: Record<string, number>;
  /** DeepSeek V4 thinking mode (default: API default). */
  thinking?: boolean;
  /** Reasoning effort for thinking mode (mapped per provider protocol by core). */
  reasoningEffort?: ReasoningEffort;
  /** Stronger model for plan runs + failure escalation (same key/endpoint). */
  planModel?: string;
  /**
   * Default-off: hand the run to `planModel` once it loops on a failed tool
   * call. Edit the file directly; not settable via `config set`.
   */
  escalateOnFailure?: boolean;
  /**
   * Default-off: confidence threshold (0..1) above which auto-extracted memory
   * facts are written directly to project.md as approved instead of pending.
   * Edit the file directly; not settable via `config set`.
   */
  memoryAutoApproveConfidence?: number;
  /** Opt-in deterministic project-memory maintenance; trusted layers only. */
  memoryMaintenance?: MemoryMaintenanceConfig;
  /**
   * Self-lint gate (parallel to a verify gate): a shell command (e.g. "pnpm
   * lint") the loop runs before finishing when files were edited but not linted
   * since. By default runs automatically on the finish turn (see autoLint). Off
   * when unset/empty. Edit the file directly; not settable via `config set`.
   */
  lintCommand?: string;
  /**
   * Default true (when lintCommand is set): run the lint command automatically
   * on completion. Set false to only nudge the model. Edit the file directly.
   */
  autoLint?: boolean;
  /**
   * Edit-tool format override ("patch" | "whole"); default is model-adaptive.
   * Mirrors the CLI/TUI config key. Edit the file directly.
   */
  editFormat?: "patch" | "whole";
  /**
   * Claude Code instruction files to load: "project" (default), "all" (also
   * ~/.claude/CLAUDE.md), "off". Mirrors the CLI/TUI key; user-owned layers only.
   */
  claudeCompat?: "off" | "project" | "all";
  /**
   * Name of a persistent browser session profile, per workspace. When set, this
   * workspace's browser context starts from
   * `~/.seekforge/browser-profiles/<name>.json` and writes it back when a run
   * finishes. Unset = every run starts logged out. See docs/browser.md.
   */
  browserProfile?: string;
  /**
   * Vision endpoint for the `image_analyze` builtin (OpenAI-compatible). The
   * main model usually cannot see images, so this is normally a separate model
   * and key. Unset leaves the tool reporting "vision_unconfigured".
   * User-owned: it names a credential destination, so a repository config
   * cannot point it anywhere.
   */
  visionModel?: { model: string; baseUrl?: string; apiKey?: string };
  /**
   * web_search's endpoint. A SearXNG base URL makes that instance the primary
   * backend with DuckDuckGo as the fallback. User config only — see
   * PROJECT_PREFERENCE_KEYS.
   */
  /**
   * web_search's backends, most authoritative first: a Brave Search API key,
   * then a SearXNG base URL, then the DuckDuckGo scrape that is always there.
   * User config only — see PROJECT_PREFERENCE_KEYS.
   */
  webSearch?: { searxngUrl?: string; braveApiKey?: string };
  /** Language servers for the lsp_* tools (user config only; see docs/lsp.md). */
  lspServers?: Record<string, LspServerConfig>;
  /** Also load Claude Code skills from `~/.claude/skills` (user config only). */
  claudeUserSkills?: boolean;
  /** User-owned shell hooks fired around tool calls / lifecycle. */
  hooks?: HookConfig;
  /** MCP servers (Claude Code-compatible). Edit the file directly; not settable via `config set`. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Share (0-100) of the context budget MCP tool definitions may take before
   * they are deferred behind tool_search. Unset = core's default.
   */
  mcpToolSearchThreshold?: number;
  /**
   * Shell command whose stdout is the API key. User-owned; the shared merge runs
   * it to fill `apiKey`, and GET /api/config never returns it.
   */
  apiKeyHelper?: string;
  /**
   * Fine-grained allow/ask/deny permission rules. First match of each action
   * category wins (deny, then ask, then allow); repository layers may only add
   * deny and ask rules. Edit trusted rules in user config.
   */
  permissionRules?: PermissionRule[];
  /** Terminal run history cap (default 500). Non-terminal runs are always retained. */
  runRetentionMaxCount?: number;
  /** Optional terminal run age limit in days. Omit to retain by count only. */
  runRetentionMaxAgeDays?: number;
};

export const CONFIG_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "models",
  // Engine knobs (UI-settable; also editable in the file directly).
  "sandbox",
  "compaction",
  "thinking",
  "reasoningEffort",
  "planModel",
  "escalateOnFailure",
  "memoryAutoApproveConfidence",
  "memoryMaintenance",
  // User-owned (absent from the shared PROJECT_PREFERENCE_KEYS): a repository
  // can neither grant a directory nor shape the sandbox's network policy, so
  // these save only with global=true.
  "additionalDirectories",
  "sandboxNetwork",
] as const;

/** Allowed values for the enum-typed config keys. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  sandbox: ["off", "read-only", "workspace-write", "restricted"],
  compaction: ["mechanical", "llm"],
  reasoningEffort: REASONING_EFFORTS,
};

const MAX_ADDITIONAL_DIRECTORIES = 64;
const MAX_DIRECTORY_CHARS = 4_096;

/**
 * Validates the Settings value for `additionalDirectories`: absolute (or `~`)
 * paths of existing directories outside this workspace, stored as the physical
 * directory that was approved (the shared owner's rule: a symlink rebound
 * later must not move the grant). An empty list clears the key.
 */
function parseAdditionalDirectoriesInput(value: unknown, workspace: string): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new ConfigValueError("additionalDirectories must be a string[] of directory paths");
  }
  const entries = value.map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new ConfigValueError(`at most ${MAX_ADDITIONAL_DIRECTORIES} additional directories`);
  }
  const stored: string[] = [];
  for (const entry of entries) {
    const absolute = isAbsolute(entry) || entry === "~" || entry.startsWith("~/");
    if (!absolute || entry.length > MAX_DIRECTORY_CHARS) {
      throw new ConfigValueError(`additional directory must be an absolute path: ${entry}`);
    }
    const physical = normalizeExtraDir(entry, workspace);
    if (physical === null) {
      throw new ConfigValueError(`not an existing directory outside this workspace: ${entry}`);
    }
    if (!stored.includes(physical)) stored.push(physical);
  }
  return stored.length > 0 ? stored : undefined;
}

export class ConfigValueError extends Error {}

export class ProjectPathError extends ConfigValueError {}

/** Root for user-owned SeekForge state; overridable for isolated deployments/tests. */
export function seekforgeHome(): string {
  const override = process.env["SEEKFORGE_HOME"];
  return override && override.length > 0 ? override : homedir();
}

function fileIdentity(stat: ReturnType<typeof fstatSync>): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function projectPath(workspace: string, rel: string, createParent: boolean): string {
  const root = realpathSync(resolve(workspace));
  const target = resolve(root, rel);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ProjectPathError(`project path escapes the workspace: ${rel}`);
  }

  const parts = fromRoot.split(sep);
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i]!);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (!createParent && (err as NodeJS.ErrnoException).code === "ENOENT") return target;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProjectPathError(`project path is not available: ${rel}`);
      }
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ProjectPathError(`project path is not available: ${rel}`);
        }
      }
      try {
        stat = lstatSync(current);
      } catch {
        throw new ProjectPathError(`project path is not available: ${rel}`);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
      throw new ProjectPathError(`project path contains a symlink: ${rel}`);
    }
  }
  return target;
}

/** Visits a workspace-owned file line by line without buffering the whole file. */
export function visitProjectFileLines(
  workspace: string,
  rel: string,
  maxLineBytes: number,
  visit: (line: string, nextOffset: number) => boolean,
  startOffset = 0,
): void {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new RangeError("startOffset must be a non-negative safe integer");
  }
  const target = projectPath(workspace, rel, false);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!fstatSync(fd).isFile()) throw new ProjectPathError(`project file is not a regular file: ${rel}`);

    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = Buffer.alloc(0);
    let position = startOffset;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        if (newline > maxLineBytes) return;
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        const nextOffset = position - pending.length;
        if (!visit(line, nextOffset)) return;
      }
      if (pending.length > maxLineBytes) return;
    }
    if (pending.length > 0 && pending.length <= maxLineBytes) visit(pending.toString("utf8"), position);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads a workspace-owned file without following project-local symlinks. */
export function readProjectFile(
  workspace: string,
  rel: string,
  maxBytes = MAX_PROJECT_STATE_FILE_BYTES,
): string | undefined {
  const target = projectPath(workspace, rel, false);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(target) !== target) {
    throw new ProjectPathError(`project file is a symlink or not a regular file: ${rel}`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) {
      throw new ProjectPathError(`project file is not a regular file: ${rel}`);
    }
    return readFileDescriptorBounded(fd, maxBytes).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Returns an O(1) identity for detecting replacement or external appends. */
export function projectFileIdentity(workspace: string, rel: string): string | undefined {
  const target = projectPath(workspace, rel, false);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ProjectPathError(`project file is not a regular file: ${rel}`);
    return fileIdentity(stat);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Appends to a workspace-owned regular file without following symlinks. */
export function appendProjectFile(workspace: string, rel: string, content: string): string {
  const target = projectPath(workspace, rel, true);
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) {
      throw new ProjectPathError(`project file is not a regular file: ${rel}`);
    }
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    return fileIdentity(fstatSync(fd));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Removes a workspace-owned regular file without following project-local symlinks. */
export function removeProjectFile(workspace: string, rel: string): boolean {
  const target = projectPath(workspace, rel, false);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new ProjectPathError(`project file is not a regular file: ${rel}`);

    // Re-resolve every parent immediately before unlink and require the path to
    // still name the inode opened above. Node has no portable unlinkat API, so
    // this narrows the remaining path-name race as far as its fs API permits.
    projectPath(workspace, rel, false);
    const current = lstatSync(target);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      realpathSync(target) !== target ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new ProjectPathError(`project file changed before deletion: ${rel}`);
    }
    unlinkSync(target);
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Atomically replaces a workspace-owned file after revalidating its physical path. */
export function writeProjectFileAtomic(workspace: string, rel: string, content: string): void {
  const target = projectPath(workspace, rel, true);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(target) !== target) {
      throw new ProjectPathError(`project file is a symlink or not a regular file: ${rel}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const temp = join(dirname(target), `.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    projectPath(workspace, rel, false);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(target) !== target) {
        throw new ProjectPathError(`project file is a symlink or not a regular file: ${rel}`);
      }
    }
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The rename consumed the temporary file, or creation failed.
    }
  }
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseConfigDoc(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  return isObjectRecord(parsed) ? parsed : {};
}

function readJson(path: string): ServerConfig {
  return readJsonConfigLayer<ServerConfig>(path, { requireObject: true });
}

/**
 * Historical stage iteration order (sessionEnd third). Passed to the shared
 * merge so the key insertion order of the merged hooks object — observable
 * through JSON serialization (e.g. GET /api/config) — stays byte-identical to
 * the old local loop.
 */
const HOOK_STAGE_ORDER: readonly HookStage[] = [
  "preToolUse",
  "postToolUse",
  "sessionEnd",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
];

/** Precedence: env > safe project preferences > .mcp.json > ~/.seekforge/config.json */
export function loadConfig(workspace: string): ServerConfig {
  return resolveServerConfig(workspace).config;
}

/** Merge warnings this process already logged; each is reported once. */
const reportedMergeWarnings = new Set<string>();

/**
 * loadConfig plus the origin of every surviving MCP server name: what the MCP
 * registry needs to decide whether a server may connect, and what the project
 * server approval routes need to tell a repository entry from the user's own.
 */
export function resolveServerConfig(workspace: string): {
  config: ServerConfig;
  mcpOrigins: Record<string, ConfigLayerOrigin>;
} {
  const global = readJson(join(seekforgeHome(), ".seekforge", "config.json"));
  let project: ServerConfig = {};
  try {
    const raw = readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES);
    if (raw !== undefined) project = parseConfigDoc(raw) as ServerConfig;
  } catch {
    // A missing, malformed, or physically unsafe project layer is ignored.
  }
  // The checkout is untrusted: it may supply ordinary preferences and stricter
  // deny rules, but cannot route user credentials, execute startup commands,
  // authorize tools, weaken isolation, mark an MCP server trusted, or repoint
  // an MCP server the user defined (the layer origin is what enforces the last).
  // Claude Code's `.mcp.json` sits right above the user layer and below the
  // project config, as in the CLI: when both project files name a server,
  // SeekForge's own file wins.
  const { config, report } = mergeConfigLayersWithReport<ServerConfig>(
    [userConfigLayer(global), readProjectMcpJsonLayer<ServerConfig>(workspace), repositoryConfigLayer(project)],
    { hookStages: HOOK_STAGE_ORDER },
  );
  // A narrowing nobody can see is its own defect; the server's log is where an
  // operator watching `seekforge serve` looks.
  for (const line of describeConfigMergeReport(report)) {
    if (reportedMergeWarnings.has(line)) continue;
    reportedMergeWarnings.add(line);
    process.stderr.write(line);
  }
  return { config, mcpOrigins: report.mcpServerOrigins };
}

/** A secret's display form: its first characters, never the whole value. */
function maskSecret(value: string): string {
  return `${value.slice(0, 6)}****`;
}

/** Config fields that are safe to return from the authenticated Settings API. */
const CONFIG_RESPONSE_KEYS = [
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "models",
  "modelPricing",
  "inlineImages",
  "sandbox",
  "sandboxNetwork",
  "additionalDirectories",
  "compaction",
  "autoCompactThreshold",
  "modelContextWindows",
  "thinking",
  "reasoningEffort",
  "planModel",
  "escalateOnFailure",
  "memoryAutoApproveConfidence",
  "memoryMaintenance",
  "editFormat",
  "claudeCompat",
  "browserProfile",
  "visionModel",
  "webSearch",
  "claudeUserSkills",
  "mcpToolSearchThreshold",
  "runRetentionMaxCount",
  "runRetentionMaxAgeDays",
] as const satisfies readonly (keyof ServerConfig)[];

/**
 * Merged config for transport (GET /api/config). Nothing that is a secret or
 * runs a command leaves the process. This is an allowlist rather than a small
 * denylist, so an unknown future or user-defined config key cannot leak:
 * - MCP/hook/LSP definitions and `apiKeyHelper` may carry commands or secrets;
 * - `lintCommand` is a command line rather than Settings data;
 * - `apiKey`, `visionModel.apiKey` and `webSearch.braveApiKey` are masked.
 * `runtimeBin` stays: it is a local path the Settings screen itself edits.
 */
function maskedConfigValue(config: ServerConfig): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of CONFIG_RESPONSE_KEYS) {
    const value = config[key];
    if (value !== undefined) merged[key] = value;
  }
  const visionModel: unknown = merged.visionModel;
  const webSearch: unknown = merged.webSearch;
  return {
    ...merged,
    ...(isObjectRecord(visionModel)
      ? {
          visionModel: {
            ...visionModel,
            ...(typeof visionModel.apiKey === "string" ? { apiKey: maskSecret(visionModel.apiKey) } : {}),
          },
        }
      : {}),
    ...(isObjectRecord(webSearch)
      ? {
          webSearch: {
            ...webSearch,
            ...(typeof webSearch.braveApiKey === "string" ? { braveApiKey: maskSecret(webSearch.braveApiKey) } : {}),
          },
        }
      : {}),
    apiKey: config.apiKey ? maskSecret(config.apiKey) : undefined,
    // Selectable model list: the user's configured ids, or core's non-deprecated
    // defaults so the picker is never empty.
    models: config.models && config.models.length > 0 ? config.models : DEFAULT_MODEL_LIST,
    // Engine knobs are always present (with their effective defaults) so the
    // UI can render the sandbox badge / thinking controls without guessing.
    sandbox: config.sandbox ?? "off",
    compaction: config.compaction ?? "mechanical",
    thinking: config.thinking ?? false,
    reasoningEffort: config.reasoningEffort ?? null,
    memoryMaintenance: resolveMemoryMaintenanceConfig(config.memoryMaintenance),
  };
}

/** Effective config for consumers that need the values a new run will use. */
export function maskedConfig(workspace: string): Record<string, unknown> {
  return maskedConfigValue(loadConfig(workspace));
}

/**
 * One persisted layer for the Settings editor. This deliberately does not
 * merge higher-precedence repository settings or environment overrides: a
 * screen editing the user layer must show what is actually stored there, not a
 * project value that would make a durable user edit look as though it vanished.
 */
export function maskedConfigLayer(workspace: string, scope: "global" | "project"): Record<string, unknown> {
  if (scope === "global") {
    return maskedConfigValue(readJson(join(seekforgeHome(), ".seekforge", "config.json")));
  }
  try {
    const raw = readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES);
    const project = raw === undefined ? {} : (parseConfigDoc(raw) as ServerConfig);
    // A repository layer is untrusted even when it is displayed in Settings.
    return maskedConfigValue(sanitizeProjectConfig(project) as ServerConfig);
  } catch {
    // Match the effective loader: a missing, malformed, or unsafe project
    // config is absent rather than a reason to expose its raw contents.
    return maskedConfigValue({});
  }
}

/** Server/Desktop config mutation boundary. Throws ConfigValueError on bad input. */
export function setConfigValue(workspace: string, key: string, value: unknown, global: boolean): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new ConfigValueError(`unknown key "${key}". Allowed: ${CONFIG_KEYS.join(", ")}`);
  }
  if (!global && !isProjectConfigKeyAllowed(key)) {
    throw new ConfigValueError(`key "${key}" is user-owned; save it with global=true`);
  }

  let stored: unknown;
  if (key === "commandAllowlist" || key === "models") {
    // Array of strings, or a comma-separated string (CLI parity).
    if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
      stored = value.map((s) => s.trim()).filter(Boolean);
    } else if (typeof value === "string") {
      stored = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new ConfigValueError(`${key} must be a string[] or a comma-separated string`);
    }
  } else if (key === "thinking" || key === "escalateOnFailure") {
    // Desktop sends strings ("true"/"false"); also accept real booleans.
    if (value === true || value === "true") stored = true;
    else if (value === false || value === "false") stored = false;
    else throw new ConfigValueError(`${key} must be true or false`);
  } else if (key === "planModel") {
    // String; empty clears it (back to using the default model).
    if (typeof value !== "string") throw new ConfigValueError("planModel must be a string");
    stored = value.trim() === "" ? undefined : value;
  } else if (key === "memoryAutoApproveConfidence") {
    // Number in 0..1; out of range (or non-numeric) is rejected.
    const num = typeof value === "string" ? Number(value) : value;
    if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > 1) {
      throw new ConfigValueError("memoryAutoApproveConfidence must be a number between 0 and 1");
    }
    stored = num;
  } else if (key === "additionalDirectories") {
    stored = parseAdditionalDirectoriesInput(value, workspace);
  } else if (key === "sandboxNetwork") {
    // null clears the policy. An object goes through core's validator, which
    // throws rather than dropping an entry (a policy that silently lost its
    // allowlist would open the network); an empty allowedDomains is a policy.
    if (value === null) stored = undefined;
    else {
      try {
        const policy = parseSandboxNetworkPolicy(value);
        stored = {
          allowedDomains: [...policy.allowedDomains],
          ...(policy.deniedDomains ? { deniedDomains: [...policy.deniedDomains] } : {}),
        };
      } catch (error) {
        throw new ConfigValueError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (key === "memoryMaintenance") {
    // Structured, trusted-only policy. Validation also rejects unknown nested
    // keys so a typo cannot silently disable a threshold or archival guard.
    try {
      stored = resolveMemoryMaintenanceConfig(value);
    } catch (error) {
      throw new ConfigValueError(error instanceof Error ? error.message : String(error));
    }
  } else if (key in ENUM_VALUES) {
    if (typeof value !== "string") throw new ConfigValueError(`${key} must be a string`);
    // reasoningEffort: empty clears it (back to the API default).
    if (key === "reasoningEffort" && value.trim() === "") stored = undefined;
    else if (!ENUM_VALUES[key]!.includes(value)) {
      throw new ConfigValueError(`${key} must be one of: ${ENUM_VALUES[key]!.join(", ")}`);
    } else stored = value;
  } else {
    if (typeof value !== "string") {
      throw new ConfigValueError(`${key} must be a string`);
    }
    stored = value;
  }

  const path = join(global ? seekforgeHome() : workspace, ".seekforge", "config.json");
  let current: Record<string, unknown> = {};
  // A malformed existing config must NOT be silently overwritten from empty —
  // that would discard every other key the user had (and a non-atomic partial
  // write could itself produce the malformed state, compounding the loss).
  // Refuse and let the user fix or remove the file.
  if (global && existsSync(path)) {
    try {
      current = parseConfigDoc(readFileBounded(path, MAX_CONFIG_FILE_BYTES).toString("utf8"));
    } catch {
      throw new ConfigValueError(`refusing to overwrite malformed ${path} — fix or delete it first`);
    }
  } else if (!global) {
    try {
      const raw = readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES);
      if (raw !== undefined) current = parseConfigDoc(raw);
    } catch (err) {
      if (err instanceof ProjectPathError) throw err;
      throw new ConfigValueError("refusing to overwrite malformed .seekforge/config.json — fix or delete it first");
    }
  }
  if (stored === undefined) delete current[key];
  else current[key] = stored;
  const serialized = `${JSON.stringify(current, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigValueError(`config exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
  }
  if (global) {
    writeGlobalConfigAtomic(path, serialized);
  } else {
    writeProjectFileAtomic(workspace, ".seekforge/config.json", serialized);
  }
}

/**
 * Append one permission rule to the USER-owned global config.
 *
 * The trust question this answers: `seekforge serve` binds 127.0.0.1 and
 * requires a bearer token, so anyone who can reach it is already the account
 * that started it — the same trust domain as the shell running the CLI. Writing
 * that account's own `~/.seekforge/config.json` is therefore exactly as correct
 * here as in the TUI. The project config is NOT an option: sanitizeProjectConfig
 * strips every allow rule from a repository layer, so a rule written there would
 * save, report success, and be discarded on every load.
 *
 * Idempotent, and it refuses a malformed existing config for the same reason
 * setConfigValue does — writing a fresh document would discard every other key.
 */
export function appendGlobalPermissionRule(rule: PermissionRule): string {
  return mutatePermissionRules("", "user", (rules) => {
    if (!rules.some((candidate) => sameRule(candidate, rule))) rules.push(rule);
  });
}

/** Physical root the global-config lease is keyed on; every writer of that file must agree on it. */
export function globalConfigLeaseRoot(): string {
  return realpathSync(resolve(seekforgeHome()));
}

/**
 * The cross-process lease around `~/.seekforge/config.json`, or a clear failure.
 *
 * It does not wait: a collision means another SeekForge process is writing the
 * same file this instant, which is rare and resolves by trying again. Blocking
 * a request on it would trade a rare, explicable error for an occasional
 * unexplained stall.
 */
function acquireGlobalConfigLease(): { release: () => void } {
  try {
    return acquireSessionLease(globalConfigLeaseRoot(), GLOBAL_CONFIG_LOCK_ID);
  } catch {
    throw new ConfigValueError("another SeekForge process is updating the global config — try again");
  }
}

function sameRule(a: unknown, b: PermissionRule): boolean {
  if (!isObjectRecord(a)) return false;
  return a.action === b.action && a.tool === b.tool && (a.match ?? "") === (b.match ?? "");
}

/** Where a permission rule is stored: the user's own config or the checkout's. */
export type PermissionRuleScope = "user" | "project";

/**
 * One stored entry as the rules editor shows it. `raw` is the file's value
 * verbatim (so an entry this build cannot parse is shown and kept, never
 * rewritten); `effective` says whether loading the layer keeps it.
 */
export type PermissionRuleEntry = { index: number; raw: unknown; rule?: PermissionRule; effective: boolean };

export const MAX_PERMISSION_RULES = 500;
const MAX_RULE_TOOL_CHARS = 256;
const MAX_RULE_MATCH_CHARS = 4_096;

/**
 * Validates one rule the editor submitted. Stricter than the loader on
 * purpose: a rule a person saves from a form should be exactly the rule that
 * runs, so unknown fields and blank tools are refused instead of dropped.
 */
export function parsePermissionRuleInput(input: unknown, scope: PermissionRuleScope): PermissionRule {
  if (!isObjectRecord(input)) throw new ConfigValueError("rule must be an object");
  const extra = Object.keys(input).filter((key) => key !== "action" && key !== "tool" && key !== "match");
  if (extra.length > 0) throw new ConfigValueError(`rule has unsupported fields: ${extra.join(", ")}`);
  const { action, tool, match } = input;
  if (action !== "allow" && action !== "deny" && action !== "ask") {
    throw new ConfigValueError('rule.action must be "allow", "deny" or "ask"');
  }
  if (typeof tool !== "string" || tool.trim() === "" || tool.trim().length > MAX_RULE_TOOL_CHARS) {
    throw new ConfigValueError(`rule.tool must be a tool name or "*" (at most ${MAX_RULE_TOOL_CHARS} characters)`);
  }
  if (match !== undefined && (typeof match !== "string" || match.length > MAX_RULE_MATCH_CHARS)) {
    throw new ConfigValueError(`rule.match must be a string of at most ${MAX_RULE_MATCH_CHARS} characters`);
  }
  const rule: PermissionRule = {
    action,
    tool: tool.trim(),
    ...(typeof match === "string" && match.trim() !== "" ? { match: match.trim() } : {}),
  };
  if (scope === "project" && !ruleSurvivesLoad(rule, "project")) {
    // The repository layer is untrusted input: it may tighten (deny, ask) but
    // never grant. An allow rule saved there would report success and then be
    // discarded on every load.
    throw new ConfigValueError("project rules may only deny or ask; save allow rules in user scope");
  }
  return rule;
}

/** Whether the shared layer owner keeps this raw entry when it loads `scope`. */
function ruleSurvivesLoad(raw: unknown, scope: PermissionRuleScope): boolean {
  const layer = { permissionRules: [raw] as PermissionRule[] };
  const loaded =
    scope === "project"
      ? sanitizeProjectConfig(layer).permissionRules
      : mergeConfigLayers([userConfigLayer(layer)], { envOverrides: false }).permissionRules;
  return (loaded?.length ?? 0) === 1;
}

function rawRulesOf(doc: Record<string, unknown>): unknown[] {
  return Array.isArray(doc.permissionRules) ? [...doc.permissionRules] : [];
}

function readPermissionRuleDoc(
  workspace: string,
  scope: PermissionRuleScope,
  strict: boolean,
): Record<string, unknown> {
  try {
    if (scope === "project") {
      const raw = readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES);
      return raw === undefined ? {} : parseConfigDoc(raw);
    }
    const path = join(seekforgeHome(), ".seekforge", "config.json");
    if (!existsSync(path)) return {};
    return parseConfigDoc(readFileBounded(path, MAX_CONFIG_FILE_BYTES).toString("utf8"));
  } catch (error) {
    if (!strict) return {};
    if (error instanceof ProjectPathError) throw error;
    const where = scope === "project" ? ".seekforge/config.json" : join(seekforgeHome(), ".seekforge", "config.json");
    throw new ConfigValueError(`refusing to overwrite malformed ${where} — fix or delete it first`);
  }
}

/** Both stored rule lists, each in file order (project rules are evaluated first). */
export function listPermissionRules(workspace: string): Record<PermissionRuleScope, PermissionRuleEntry[]> {
  const entries = (scope: PermissionRuleScope): PermissionRuleEntry[] =>
    rawRulesOf(readPermissionRuleDoc(workspace, scope, false)).map((raw, index) => {
      const effective = ruleSurvivesLoad(raw, scope);
      const parsed = ruleSurvivesLoad(raw, "user") ? (raw as PermissionRule) : undefined;
      return { index, raw, ...(parsed ? { rule: parsed } : {}), effective };
    });
  return { project: entries("project"), user: entries("user") };
}

/**
 * The one read-modify-write of a stored `permissionRules` list. User scope
 * takes the cross-process global-config lease itself; project scope expects
 * the caller to hold the repository/workspace guard. A malformed file is
 * refused rather than replaced, because writing a fresh document would discard
 * every other key. Returns the path written.
 */
export function mutatePermissionRules(
  workspace: string,
  scope: PermissionRuleScope,
  mutate: (rules: unknown[]) => void,
): string {
  const lease = scope === "user" ? acquireGlobalConfigLease() : undefined;
  try {
    const doc = readPermissionRuleDoc(workspace, scope, true);
    const rules = rawRulesOf(doc);
    mutate(rules);
    if (rules.length > MAX_PERMISSION_RULES) {
      throw new ConfigValueError(`at most ${MAX_PERMISSION_RULES} permission rules per scope`);
    }
    if (rules.length === 0) delete doc.permissionRules;
    else doc.permissionRules = rules;
    const serialized = `${JSON.stringify(doc, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_FILE_BYTES) {
      throw new ConfigValueError(`config exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
    }
    if (scope === "project") {
      writeProjectFileAtomic(workspace, ".seekforge/config.json", serialized);
      return join(workspace, ".seekforge", "config.json");
    }
    const path = join(seekforgeHome(), ".seekforge", "config.json");
    writeGlobalConfigAtomic(path, serialized);
    return path;
  } finally {
    lease?.release();
  }
}

/** Atomic + fsync write for the global (~/.seekforge) config, with symlink guard. */
function writeGlobalConfigAtomic(path: string, serialized: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new ConfigValueError("global config must not be a symbolic link");
  }
  const temp = join(dir, `.config.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // rename consumed the temp file, or creation failed
    }
  }
}
