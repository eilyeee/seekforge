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
  DEPRECATED_MODELS,
  MODEL_PRICING,
  type HookConfig,
  type McpServerConfig,
  type ModelPricing,
} from "@seekforge/core";
import type { HookStage, PermissionRule } from "@seekforge/shared";
import { readFileBounded, readFileDescriptorBounded } from "@seekforge/shared/bounded-file-read";
import { MAX_CONFIG_FILE_BYTES, mergeConfigLayers, readJsonConfigLayer } from "@seekforge/shared/config-layers";

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
  /** OS-level command sandbox (off when unset). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). */
  thinking?: boolean;
  /** Reasoning effort for thinking mode. */
  reasoningEffort?: "high" | "max";
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
  /** Shell hooks fired around tool calls / lifecycle. Edit the file directly. */
  hooks?: HookConfig;
  /** MCP servers (Claude Code-compatible). Edit the file directly; not settable via `config set`. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Fine-grained allow/deny permission rules. First match of each action
   * category wins (deny scanned before allow); project rules are merged
   * before global ones. Edit the file directly; not settable via `config set`.
   */
  permissionRules?: PermissionRule[];
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
] as const;

/** Allowed values for the enum-typed config keys. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  sandbox: ["off", "read-only", "workspace-write", "restricted"],
  compaction: ["mechanical", "llm"],
  reasoningEffort: ["high", "max"],
};

export class ConfigValueError extends Error {}

export class ProjectPathError extends ConfigValueError {}

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
  visit: (line: string) => boolean,
): void {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
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
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        if (newline > maxLineBytes) return;
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        if (!visit(line)) return;
      }
      if (pending.length > maxLineBytes) return;
    }
    if (pending.length > 0 && pending.length <= maxLineBytes) visit(pending.toString("utf8"));
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

/** Precedence: env > project .seekforge/config.json > ~/.seekforge/config.json */
export function loadConfig(workspace: string): ServerConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  let project: ServerConfig = {};
  try {
    const raw = readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES);
    if (raw !== undefined) project = parseConfigDoc(raw) as ServerConfig;
  } catch {
    // A missing, malformed, or physically unsafe project layer is ignored.
  }
  // Shared merge algebra (see @seekforge/shared/config-layers): scalars spread
  // project-over-global; mcpServers merge per server name (project wins);
  // permissionRules concatenate project-then-global (first match wins); hooks
  // concatenate per stage global-then-project (every hook runs); then the
  // provider-aware env API key + SEEKFORGE_RUNTIME_BIN overrides land on top.
  // Mirrors the CLI minus its local/profile/--settings layers.
  return mergeConfigLayers<ServerConfig>([global, project], { hookStages: HOOK_STAGE_ORDER });
}

/** Merged config with the apiKey masked for transport (GET /api/config). */
export function maskedConfig(workspace: string): Record<string, unknown> {
  // mcpServers is omitted entirely: entries may carry secret env values
  // (GET /api/mcp exposes a sanitized view instead).
  const { mcpServers: _mcpServers, ...merged } = loadConfig(workspace);
  return {
    ...merged,
    apiKey: merged.apiKey ? `${merged.apiKey.slice(0, 6)}****` : undefined,
    // Selectable model list: the user's configured ids, or core's non-deprecated
    // defaults so the picker is never empty.
    models: merged.models && merged.models.length > 0 ? merged.models : DEFAULT_MODEL_LIST,
    // Engine knobs are always present (with their effective defaults) so the
    // UI can render the sandbox badge / thinking controls without guessing.
    sandbox: merged.sandbox ?? "off",
    compaction: merged.compaction ?? "mechanical",
    thinking: merged.thinking ?? false,
    reasoningEffort: merged.reasoningEffort ?? null,
  };
}

/**
 * Same keys/validation as `seekforge config set`.
 * Throws ConfigValueError on an unknown key or a bad value (HTTP 400).
 */
export function setConfigValue(workspace: string, key: string, value: unknown, global: boolean): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new ConfigValueError(`unknown key "${key}". Allowed: ${CONFIG_KEYS.join(", ")}`);
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

  const path = join(global ? homedir() : workspace, ".seekforge", "config.json");
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
