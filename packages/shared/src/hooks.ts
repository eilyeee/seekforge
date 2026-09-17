/**
 * Hook configuration contract: the stages, the entry shape, and the pure
 * validation every surface applies to it (config merge, the REST hooks editor,
 * plugin manifests, the runtime matcher). Browser-safe and dependency-free, so
 * the desktop editor can validate with the same rules the engine enforces.
 *
 * Runtime behavior (running a hook, interpreting its output) lives in
 * `@seekforge/core`'s hooks module; see docs/hooks.md for the user contract.
 */

/** Every hook stage, in declaration order. Surfaces iterate this list. */
export const HOOK_STAGES = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
  "sessionEnd",
  "postToolUseFailure",
  "permissionRequest",
  "subagentStart",
  "postCompact",
] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

/**
 * Stages where a failing hook (non-zero exit, HTTP error, timeout, missing
 * evaluator) blocks the tool call / run instead of being logged.
 */
export const BLOCKING_HOOK_STAGES: readonly HookStage[] = ["preToolUse", "userPromptSubmit"];

/** How a hook runs: a shell command (default), an HTTP POST, or a model check. */
export const HOOK_TYPES = ["command", "http", "prompt"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/** Upper bound for a per-entry `timeout`, in seconds. */
export const HOOK_TIMEOUT_MAX_SECONDS = 600;
/** Default per-entry timeout, in seconds, when `timeout` is absent. */
export const HOOK_DEFAULT_TIMEOUT_SECONDS: Readonly<Record<HookType, number>> = {
  command: 10,
  http: 10,
  prompt: 30,
};

/** Longest `match` accepted; a matcher is a name list or a short regex. */
export const HOOK_MATCHER_MAX_LENGTH = 256;
/** Longest `prompt` accepted for a prompt hook. */
export const HOOK_PROMPT_MAX_LENGTH = 20_000;

/**
 * One hook entry. The wire shape is flat so an editor can round-trip it
 * without narrowing: which fields apply depends on `type`.
 */
export type HookEntry = {
  /** "command" (default), "http" or "prompt". */
  type?: HookType;
  /**
   * Which calls the hook applies to. "*", "" or absent = all. Letters, digits,
   * `_`, `-` separated by `|` or `,` = a list of exact names (`Edit|Write`);
   * anything else is a regular expression matched against the WHOLE name.
   * Matched against the tool name on tool stages and the agent id on
   * subagentStart/subagentStop; ignored on the other stages.
   */
  match?: string;
  /**
   * Prefix tested against the classified raw command (run_command family) or
   * path (fs tools), like PermissionRule.match. Absent = any call.
   */
  pattern?: string;
  /** Seconds before the hook is abandoned (0 < timeout ≤ 600). */
  timeout?: number;
  /** type "command": shell command, run via `/bin/sh -c` with cwd = workspace. */
  command?: string;
  /** type "http": http(s) URL the JSON payload is POSTed to. */
  url?: string;
  /** type "http": extra request headers; `${VAR}` expands variables named in allowedEnvVars. */
  headers?: Record<string, string>;
  /** type "http": environment variables `headers` may expand. Others expand to "". */
  allowedEnvVars?: string[];
  /** type "prompt": the condition a model evaluates; `$ARGUMENTS` marks where the payload goes. */
  prompt?: string;
  /** type "prompt": model to evaluate with, when the host can route to it. */
  model?: string;
};

/** Stage → entries. */
export type HooksConfig = Partial<Record<HookStage, HookEntry[]>>;

export type HookParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHookStage(value: unknown): value is HookStage {
  return typeof value === "string" && (HOOK_STAGES as readonly string[]).includes(value);
}

/** The entry's effective type ("command" when unset). */
export function hookEntryType(entry: HookEntry): HookType {
  return entry.type ?? "command";
}

/**
 * A short, secret-free label for an entry: the command, `POST origin/path`
 * (never the query string, which may carry a token), or the prompt's head.
 */
export function hookEntryLabel(entry: HookEntry): string {
  switch (hookEntryType(entry)) {
    case "http": {
      try {
        const url = new URL(entry.url ?? "");
        return `POST ${url.origin}${url.pathname}`;
      } catch {
        return "POST (invalid url)";
      }
    }
    case "prompt": {
      const head = (entry.prompt ?? "").replace(/\s+/g, " ").trim();
      return `prompt: ${head.length > 60 ? `${head.slice(0, 60)}…` : head}`;
    }
    default:
      return entry.command ?? "";
  }
}

const MATCHER_NAME_LIST = /^[A-Za-z0-9_\-|,\s]*$/;
/** Regex matchers only run against subjects up to this length. */
const MATCHER_SUBJECT_MAX_LENGTH = 128;
/** Repeating quantifiers a regex matcher may use (bounds polynomial backtracking). */
const MATCHER_MAX_REPEATS = 4;

/**
 * Why a regex matcher is refused, or undefined when it is acceptable. The
 * subject is a short identifier, so the only real hazard is exponential
 * backtracking: a repeated group that itself repeats or alternates. Those are
 * refused outright, as are backreferences, and the total number of repeating
 * quantifiers is capped so stacked `.*` cannot go polynomial either.
 */
function unsafeMatcherReason(source: string): string | undefined {
  if (/\\[1-9]|\\k</.test(source)) return "backreferences are not allowed";
  // Each open group records whether it contains a quantifier or alternation.
  const groups: boolean[] = [false];
  let lastAtomRisky = false;
  let repeats = 0;
  let i = 0;
  const markRisky = (): void => {
    groups[groups.length - 1] = true;
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i += 2;
      lastAtomRisky = false;
      continue;
    }
    if (ch === "[") {
      i++;
      if (source[i] === "^") i++;
      if (source[i] === "]") i++;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i++;
      lastAtomRisky = false;
      continue;
    }
    if (ch === "(") {
      groups.push(false);
      i++;
      if (source[i] === "?") {
        i++;
        if (source[i] === "<" && source[i + 1] !== "=" && source[i + 1] !== "!") {
          const close = source.indexOf(">", i);
          i = close === -1 ? source.length : close + 1;
        } else {
          i += source[i] === "<" ? 2 : 1;
        }
      }
      lastAtomRisky = false;
      continue;
    }
    if (ch === ")") {
      const risky = groups.length > 1 ? groups.pop()! : false;
      if (risky) markRisky();
      lastAtomRisky = risky;
      i++;
      continue;
    }
    if (ch === "|") {
      markRisky();
      lastAtomRisky = false;
      i++;
      continue;
    }
    let repeating: boolean | undefined;
    let width = 1;
    if (ch === "*" || ch === "+") repeating = true;
    else if (ch === "?") repeating = false;
    else if (ch === "{") {
      const bound = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (bound) {
        const max = bound[2] === undefined ? Number(bound[1]) : bound[3] === "" ? Infinity : Number(bound[3]);
        repeating = max > 1;
        width = bound[0].length;
      }
    }
    if (repeating === undefined) {
      lastAtomRisky = false;
      i++;
      continue;
    }
    if (repeating) {
      if (lastAtomRisky) return "a repeated group may not itself repeat or alternate";
      repeats++;
      if (repeats > MATCHER_MAX_REPEATS) return `at most ${MATCHER_MAX_REPEATS} repeating quantifiers are allowed`;
    }
    markRisky();
    lastAtomRisky = false;
    i += width;
    if (source[i] === "?") i++; // lazy modifier
  }
  return undefined;
}

/**
 * Compiles a `match` value into a predicate over a tool name / agent id.
 * Refuses (rather than guessing at) a regex that does not compile or could
 * backtrack pathologically.
 */
export function compileHookMatcher(match: string | undefined): HookParseResult<(subject: string) => boolean> {
  const text = (match ?? "").trim();
  if (text === "" || text === "*") return { ok: true, value: () => true };
  if (text.length > HOOK_MATCHER_MAX_LENGTH) {
    return { ok: false, error: `match is longer than ${HOOK_MATCHER_MAX_LENGTH} characters` };
  }
  if (MATCHER_NAME_LIST.test(text)) {
    const names = new Set(
      text
        .split(/[|,]/)
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    );
    if (names.size === 0) return { ok: false, error: "match names no tool" };
    return { ok: true, value: (subject) => names.has(subject) };
  }
  const unsafe = unsafeMatcherReason(text);
  if (unsafe !== undefined) return { ok: false, error: `match ${JSON.stringify(text)} is refused: ${unsafe}` };
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${text})$`);
  } catch (error) {
    return { ok: false, error: `match is not a valid regular expression: ${(error as Error).message}` };
  }
  return { ok: true, value: (subject) => subject.length <= MATCHER_SUBJECT_MAX_LENGTH && re.test(subject) };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function optionalString(entry: Record<string, unknown>, key: string): HookParseResult<string | undefined> {
  const value = entry[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${key} must be a string` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

/**
 * Validates one hook entry and returns its normalized form: blank optional
 * strings dropped, strings trimmed, fields of other hook types dropped.
 */
export function parseHookEntry(value: unknown): HookParseResult<HookEntry> {
  if (!isPlainRecord(value)) return { ok: false, error: "hook entry must be an object" };
  const rawType = value.type;
  if (rawType !== undefined && !(HOOK_TYPES as readonly unknown[]).includes(rawType)) {
    return { ok: false, error: `unknown hook type ${JSON.stringify(rawType)}` };
  }
  const type = (rawType ?? "command") as HookType;
  const entry: HookEntry = rawType !== undefined ? { type } : {};

  const match = optionalString(value, "match");
  if (!match.ok) return match;
  if (match.value !== undefined) {
    const compiled = compileHookMatcher(match.value);
    if (!compiled.ok) return compiled;
    entry.match = match.value;
  }
  const pattern = optionalString(value, "pattern");
  if (!pattern.ok) return pattern;
  if (pattern.value !== undefined) entry.pattern = pattern.value;

  if (value.timeout !== undefined) {
    const timeout = value.timeout;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return { ok: false, error: "timeout must be a positive number of seconds" };
    }
    if (timeout > HOOK_TIMEOUT_MAX_SECONDS) {
      return { ok: false, error: `timeout may not exceed ${HOOK_TIMEOUT_MAX_SECONDS} seconds` };
    }
    entry.timeout = timeout;
  }

  if (type === "command") {
    const command = optionalString(value, "command");
    if (!command.ok) return command;
    if (command.value === undefined) return { ok: false, error: "a command hook needs a non-empty command" };
    entry.command = command.value;
    return { ok: true, value: entry };
  }

  if (type === "http") {
    const url = optionalString(value, "url");
    if (!url.ok) return url;
    if (url.value === undefined) return { ok: false, error: "an http hook needs a url" };
    let parsed: URL;
    try {
      parsed = new URL(url.value);
    } catch {
      return { ok: false, error: `url is not a valid URL: ${url.value}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "url must use http or https" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, error: "url may not carry credentials; send them in headers" };
    }
    entry.url = url.value;
    if (value.headers !== undefined) {
      if (!isPlainRecord(value.headers)) return { ok: false, error: "headers must be an object of strings" };
      const headers: Record<string, string> = {};
      for (const [name, headerValue] of Object.entries(value.headers)) {
        if (!HEADER_NAME.test(name)) return { ok: false, error: `invalid header name ${JSON.stringify(name)}` };
        if (typeof headerValue !== "string" || /[\r\n\0]/.test(headerValue)) {
          return { ok: false, error: `header ${name} must be a single-line string` };
        }
        headers[name] = headerValue;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    if (value.allowedEnvVars !== undefined) {
      const names = value.allowedEnvVars;
      if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && ENV_NAME.test(name))) {
        return { ok: false, error: "allowedEnvVars must be a list of environment variable names" };
      }
      if (names.length > 0) entry.allowedEnvVars = [...new Set(names as string[])];
    }
    return { ok: true, value: entry };
  }

  const prompt = optionalString(value, "prompt");
  if (!prompt.ok) return prompt;
  if (prompt.value === undefined) return { ok: false, error: "a prompt hook needs a non-empty prompt" };
  if (prompt.value.length > HOOK_PROMPT_MAX_LENGTH) {
    return { ok: false, error: `prompt is longer than ${HOOK_PROMPT_MAX_LENGTH} characters` };
  }
  entry.prompt = prompt.value;
  const model = optionalString(value, "model");
  if (!model.ok) return model;
  if (model.value !== undefined) entry.model = model.value;
  return { ok: true, value: entry };
}

/**
 * Strict validation of a whole hooks object (the hooks editor's PUT body):
 * the first unknown stage, non-array stage, or invalid entry fails the lot,
 * naming where. Empty stages are dropped.
 */
export function parseHooksConfig(value: unknown): HookParseResult<HooksConfig> {
  if (!isPlainRecord(value)) return { ok: false, error: "hooks must be an object" };
  const hooks: HooksConfig = {};
  for (const [stage, entries] of Object.entries(value)) {
    if (!isHookStage(stage)) return { ok: false, error: `unknown hook stage: ${stage}` };
    if (!Array.isArray(entries)) return { ok: false, error: `${stage} must be an array` };
    const parsed: HookEntry[] = [];
    for (const [index, raw] of entries.entries()) {
      const entry = parseHookEntry(raw);
      if (!entry.ok) return { ok: false, error: `${stage}[${index}]: ${entry.error}` };
      parsed.push(entry.value);
    }
    if (parsed.length > 0) hooks[stage] = parsed;
  }
  return { ok: true, value: hooks };
}

/**
 * Lenient per-entry filter for merged config layers: invalid entries are
 * dropped (a malformed hook never runs), valid ones are normalized.
 */
export function sanitizeHookEntries(entries: unknown): HookEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: HookEntry[] = [];
  for (const raw of entries) {
    const entry = parseHookEntry(raw);
    if (entry.ok) out.push(entry.value);
  }
  return out;
}
