// Flag resolution shared by the headless run path (run/ask/-p) and the REPL.
// Every function here only reads and validates, so a caller can finish all of
// it before authorizing the workspace, forking a session, provisioning a
// worktree or spawning MCP servers. Problems surface as RunSetupError, which
// both callers turn into one `error: … / hint: …` line.

import {
  isValidSessionId,
  jsonSchemaProblems,
  listSessions,
  parseInlineAgentDefinitions,
  readSessionMeta,
  type AgentDefinition,
} from "@seekforge/core";
import type { ConfigLayerOrigin } from "@seekforge/shared/config-layers";
import { normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import type { CliConfig } from "./config.js";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { t } from "./i18n.js";
import { extractMcpServersDoc } from "./mcp-config.js";
import { resolveOutputStyle } from "./output-style.js";

export class RunSetupError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RunSetupError";
  }
}

/** Largest --system-prompt-file / --append-system-prompt-file accepted. */
export const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
/** Largest --json-schema (inline or file) accepted. */
export const MAX_JSON_SCHEMA_BYTES = 256 * 1024;

export type PromptFlags = {
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  outputStyle?: string;
};

function readFlagFile(flag: string, path: string, maxBytes: number): string {
  try {
    return readTextFileBounded(path, maxBytes);
  } catch (error) {
    throw new RunSetupError(
      t("err.flagFileRead", { flag, path }),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function exclusive(a: string, aSet: boolean, b: string, bSet: boolean): void {
  if (aSet && bSet) throw new RunSetupError(t("err.bothFlags", { a, b }));
}

/**
 * The system prompt override and the text appended to the composed prompt:
 * --system-prompt(-file) replaces it; --output-style's preset and
 * --append-system-prompt(-file) are appended, in that order, to whichever
 * prompt is in effect.
 */
export function resolvePromptFlags(
  flags: PromptFlags,
  projectPath: string,
): { systemPrompt?: string; appendSystemPrompt?: string } {
  exclusive("--system-prompt", flags.systemPrompt !== undefined, "--system-prompt-file", !!flags.systemPromptFile);
  exclusive(
    "--append-system-prompt",
    flags.appendSystemPrompt !== undefined,
    "--append-system-prompt-file",
    !!flags.appendSystemPromptFile,
  );
  const systemPrompt = flags.systemPromptFile
    ? readFlagFile("--system-prompt-file", flags.systemPromptFile, MAX_PROMPT_FILE_BYTES)
    : flags.systemPrompt;
  const append = flags.appendSystemPromptFile
    ? readFlagFile("--append-system-prompt-file", flags.appendSystemPromptFile, MAX_PROMPT_FILE_BYTES)
    : flags.appendSystemPrompt;
  let styleAddendum: string | undefined;
  if (flags.outputStyle) {
    try {
      styleAddendum = resolveOutputStyle(flags.outputStyle, projectPath);
    } catch {
      throw new RunSetupError(
        t("err.unknownOutputStyle", { style: flags.outputStyle }),
        t("err.unknownOutputStyleHint"),
      );
    }
  }
  const appendSystemPrompt = [styleAddendum, append].filter((s): s is string => !!s).join("\n\n") || undefined;
  // Core uses a replacement prompt verbatim and appends nothing to it, so the
  // two are joined here rather than the append being dropped.
  if (systemPrompt !== undefined) {
    return { systemPrompt: appendSystemPrompt ? `${systemPrompt}\n\n${appendSystemPrompt}` : systemPrompt };
  }
  return appendSystemPrompt !== undefined ? { appendSystemPrompt } : {};
}

/**
 * --mcp-config merges a JSON file's servers over the config's (the file wins
 * per name); --strict-mcp-config uses only the file's, or none without one.
 */
export function resolveMcpServers(
  config: CliConfig,
  flags: { mcpConfig?: string; strictMcpConfig?: boolean },
): CliConfig {
  return resolveMcpSetup(config, {}, flags).config;
}

export type McpOrigins = Record<string, ConfigLayerOrigin>;

/**
 * resolveMcpServers plus who defined each surviving server: an explicit
 * --mcp-config file is the user's (like --settings) and wins per name, and
 * --strict-mcp-config leaves only the file's servers. The origins decide which
 * servers may connect (see core mcpConnectionDecision).
 */
export function resolveMcpSetup(
  config: CliConfig,
  origins: Readonly<McpOrigins>,
  flags: { mcpConfig?: string; strictMcpConfig?: boolean },
): { config: CliConfig; origins: McpOrigins } {
  // Keyed by server names, which come from files: no inherited keys may answer
  // for a name ("constructor", "__proto__").
  const nextOrigins: McpOrigins = Object.create(null);
  if (!flags.strictMcpConfig) Object.assign(nextOrigins, origins);
  if (!flags.mcpConfig) {
    return { config: flags.strictMcpConfig ? { ...config, mcpServers: {} } : config, origins: nextOrigins };
  }
  let fileServers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readTextFileBounded(flags.mcpConfig, MAX_CONFIG_FILE_BYTES)) as unknown;
    const extracted = extractMcpServersDoc(parsed);
    if (!extracted) throw new Error("invalid MCP config shape");
    fileServers = extracted;
  } catch {
    throw new RunSetupError(t("err.mcpConfigRead", { path: flags.mcpConfig }), t("err.mcpConfigReadHint"));
  }
  const merged = flags.strictMcpConfig ? fileServers : { ...config.mcpServers, ...fileServers };
  for (const name of Object.keys(fileServers)) nextOrigins[name] = "user";
  return { config: { ...config, mcpServers: merged as CliConfig["mcpServers"] }, origins: nextOrigins };
}

/**
 * --add-dir values as absolute, physical directories outside the project,
 * each once; `skipped` are the values that are not (missing, not a directory,
 * or inside the project). Core re-validates the kept ones on every run.
 */
export function resolveAddDirs(
  raw: readonly string[] | undefined,
  projectPath: string,
): { dirs: string[]; skipped: string[] } {
  const dirs: string[] = [];
  const skipped: string[] = [];
  for (const value of raw ?? []) {
    const abs = normalizeExtraDir(value, projectPath);
    if (!abs) skipped.push(value);
    else if (!dirs.includes(abs)) dirs.push(abs);
  }
  return { dirs, skipped };
}

/** The parsed --json-schema / --json-schema-file, or undefined when neither is set. */
export function loadJsonSchemaFlag(flags: { jsonSchema?: string; jsonSchemaFile?: string }): unknown {
  exclusive("--json-schema", flags.jsonSchema !== undefined, "--json-schema-file", !!flags.jsonSchemaFile);
  const raw = flags.jsonSchemaFile
    ? readFlagFile("--json-schema-file", flags.jsonSchemaFile, MAX_JSON_SCHEMA_BYTES)
    : flags.jsonSchema;
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_SCHEMA_BYTES) {
    throw new RunSetupError(t("err.jsonSchemaInvalid", { detail: `larger than ${MAX_JSON_SCHEMA_BYTES} bytes` }));
  }
  let schema: unknown;
  try {
    schema = JSON.parse(raw);
  } catch (error) {
    throw new RunSetupError(
      t("err.jsonSchemaInvalid", { detail: error instanceof Error ? error.message : "not valid JSON" }),
    );
  }
  const problems = jsonSchemaProblems(schema);
  if (problems.length > 0) throw new RunSetupError(t("err.jsonSchemaInvalid", { detail: problems.join("; ") }));
  return schema;
}

/** The --agents definitions, or [] when the flag is absent. */
export function parseAgentsFlag(raw: string | undefined): AgentDefinition[] {
  if (raw === undefined) return [];
  try {
    return parseInlineAgentDefinitions(raw);
  } catch (error) {
    throw new RunSetupError(error instanceof Error ? error.message : String(error), t("err.agentsHint"));
  }
}

export type SessionFlags = {
  continueLast?: boolean;
  resumeSessionId?: string;
  forkSession?: boolean;
  sessionId?: string;
};

export type SessionPlan = {
  /** Session to continue (after forking, when `fork` is set). */
  resumeSessionId?: string;
  /** Its stored mode; a resumed session keeps it. */
  resumeMode?: "ask" | "edit";
  /** Fork `resumeSessionId` into a new session before the first run. */
  fork?: boolean;
  /** Id for the new session the first run creates. */
  newSessionId?: string;
};

/** Validates --continue/--resume/--fork-session/--session-id against the stored sessions. */
export function resolveSessionFlags(projectPath: string, flags: SessionFlags): SessionPlan {
  const resuming = flags.resumeSessionId !== undefined || flags.continueLast === true;
  if (flags.sessionId !== undefined) {
    if (resuming || flags.forkSession) throw new RunSetupError(t("err.sessionIdConflict"));
    if (!isValidSessionId(flags.sessionId)) {
      throw new RunSetupError(t("err.sessionIdInvalid", { id: flags.sessionId }), t("err.sessionIdInvalidHint"));
    }
    if (readSessionMeta(projectPath, flags.sessionId)) {
      throw new RunSetupError(
        t("err.sessionIdExists", { id: flags.sessionId }),
        t("err.sessionIdExistsHint", { id: flags.sessionId }),
      );
    }
    return { newSessionId: flags.sessionId };
  }
  if (flags.forkSession && !resuming) throw new RunSetupError(t("err.forkNeedsResume"));
  if (!resuming) return {};
  // An explicit --resume wins over -c.
  let id = flags.resumeSessionId;
  if (id === undefined) {
    const recent = listSessions(projectPath)[0];
    if (!recent) throw new RunSetupError(t("err.noPreviousSession"), t("err.noPreviousSessionHint"));
    id = recent.id;
  }
  const meta = readSessionMeta(projectPath, id);
  if (!meta) throw new RunSetupError(t("err.sessionNotFound", { id }), t("err.sessionNotFoundHint"));
  return { resumeSessionId: id, resumeMode: meta.mode, ...(flags.forkSession ? { fork: true } : {}) };
}
