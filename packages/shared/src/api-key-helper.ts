/**
 * `apiKeyHelper`: a user-configured shell command whose stdout is the provider
 * API key — for keys that live in a vault, rotate, or expire.
 *
 * The one process-wide cache is here, and so is the only code that runs the
 * command, because two callers need the same answer: the config merge
 * (config-layers.ts), which fills `apiKey` so every frontend sees a key, and
 * the provider (core), which refreshes it when it ages out and once on a 401.
 * The provider finds the helper that issued a key with `apiKeyHelperFor`, so a
 * key that came from a helper stays refreshable however many frontend layers
 * it passed through on the way.
 *
 * The key is a secret: it is never logged, never put in an error message, and
 * nothing the command prints on stderr is kept, because a helper is free to
 * print whatever it likes there. An error says how the command failed, never
 * what it printed.
 *
 * Only user-owned config layers may name a helper: it runs a command, so a
 * repository that could set it would run code on checkout (see
 * PROJECT_PREFERENCE_KEYS in config-layers.ts, which it is absent from).
 *
 * NODE-ONLY (child_process), behind the "./api-key-helper" subpath export.
 */

import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_API_KEY_HELPER_TTL_MS = 5 * 60_000;
export const API_KEY_HELPER_TIMEOUT_MS = 10_000;
/** A key is a token, not a document; more than this is not a key. */
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
/** Keys remembered for `apiKeyHelperFor`; a rotating helper must not grow this forever. */
const MAX_REMEMBERED_KEYS = 32;

export class ApiKeyHelperError extends Error {
  constructor(message: string) {
    super(`apiKeyHelper ${message}`);
    this.name = "ApiKeyHelperError";
  }
}

type CacheEntry = { key: string; fetchedAt: number };

export type HelperRunOptions = {
  /** Kill the command after this long (default API_KEY_HELPER_TIMEOUT_MS). */
  timeoutMs?: number;
};

const latest = new Map<string, CacheEntry>();
const issuedBy = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
/**
 * A recent synchronous failure, replayed instead of re-run. The config loader
 * runs on nearly every server route; without this a broken helper would block
 * each one for up to the full timeout.
 */
const recentFailures = new Map<string, { error: ApiKeyHelperError; at: number }>();
const FAILURE_REPLAY_MS = 30_000;

/**
 * How long a helper's key is used before the command runs again, from
 * `SEEKFORGE_API_KEY_HELPER_TTL_MS`. `0` runs it before every request; an
 * unset or malformed value is the 5-minute default.
 */
export function apiKeyHelperTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["SEEKFORGE_API_KEY_HELPER_TTL_MS"]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_API_KEY_HELPER_TTL_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : DEFAULT_API_KEY_HELPER_TTL_MS;
}

/** A configured helper command, or undefined when the value is not a usable one. */
export function normalizeApiKeyHelper(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The helper command that produced `key`, if one did in this process. */
export function apiKeyHelperFor(key: string | undefined): string | undefined {
  return key ? issuedBy.get(key) : undefined;
}

function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.fetchedAt < apiKeyHelperTtlMs();
}

function remember(command: string, key: string): string {
  recentFailures.delete(command);
  latest.set(command, { key, fetchedAt: Date.now() });
  issuedBy.delete(key);
  issuedBy.set(key, command);
  while (issuedBy.size > MAX_REMEMBERED_KEYS) {
    const oldest = issuedBy.keys().next().value as string;
    issuedBy.delete(oldest);
  }
  return key;
}

/** Validate what the command printed. The message never quotes it. */
function keyFromOutput(stdout: Buffer): string {
  if (stdout.byteLength > MAX_HELPER_OUTPUT_BYTES) {
    throw new ApiKeyHelperError(`printed more than ${MAX_HELPER_OUTPUT_BYTES} bytes; expected a single key`);
  }
  const key = stdout.toString("utf8").trim();
  if (key === "") throw new ApiKeyHelperError("printed nothing on stdout; expected the API key");
  // A key travels in an HTTP header: whitespace or a control character inside
  // it is either two things printed or a header-injection attempt.
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/.test(char)) {
      throw new ApiKeyHelperError("printed more than one token on stdout; expected a single key");
    }
  }
  return key;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `was killed by ${signal}` : `exited with code ${code}`;
}

const HINT = "; run the command in a shell to see its output";

/**
 * The helper's key, running the command synchronously only when this process
 * has never run it. A key past its TTL is returned as-is while a refresh runs
 * in the background — the config merge must not stall a server route on a slow
 * vault, and the provider awaits a fresh key before it sends anything anyway.
 */
export function resolveApiKeyHelperSync(command: string, options: HelperRunOptions = {}): string {
  const now = Date.now();
  const entry = latest.get(command);
  if (entry !== undefined) {
    if (isFresh(entry, now)) return entry.key;
    void refreshApiKeyHelper(command, undefined, options).catch(() => {});
    return entry.key;
  }
  const failure = recentFailures.get(command);
  if (failure !== undefined && now - failure.at < FAILURE_REPLAY_MS) throw failure.error;
  try {
    return remember(command, runHelperSync(command, options));
  } catch (error) {
    if (error instanceof ApiKeyHelperError) recentFailures.set(command, { error, at: now });
    throw error;
  }
}

function runHelperSync(command: string, options: HelperRunOptions): string {
  const timeoutMs = options.timeoutMs ?? API_KEY_HELPER_TIMEOUT_MS;
  const result = spawnSync(command, {
    shell: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_HELPER_OUTPUT_BYTES + 1,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new ApiKeyHelperError(`timed out after ${timeoutMs}ms${HINT}`);
    if (code === "ENOBUFS") {
      throw new ApiKeyHelperError(`printed more than ${MAX_HELPER_OUTPUT_BYTES} bytes; expected a single key`);
    }
    throw new ApiKeyHelperError(`could not be started (${code ?? "spawn failed"})`);
  }
  if (result.status !== 0) throw new ApiKeyHelperError(`${describeExit(result.status, result.signal)}${HINT}`);
  return keyFromOutput(result.stdout);
}

function runHelper(command: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: ApiKeyHelperError | undefined;
    const stop = (error: ApiKeyHelperError): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new ApiKeyHelperError(`timed out after ${timeoutMs}ms${HINT}`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_HELPER_OUTPUT_BYTES) {
        stop(new ApiKeyHelperError(`printed more than ${MAX_HELPER_OUTPUT_BYTES} bytes; expected a single key`));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(failure ?? new ApiKeyHelperError(`could not be started (${error.code ?? "spawn failed"})`));
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ApiKeyHelperError(`${describeExit(code, killedBy)}${HINT}`));
      try {
        resolve(keyFromOutput(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Run the helper now (one run per command at a time, shared by every caller
 * that asks meanwhile) and cache what it prints. A caller's signal stops only
 * its own wait: the run is shared, and bounded by its own timeout.
 */
export function refreshApiKeyHelper(
  command: string,
  signal?: AbortSignal,
  options: HelperRunOptions = {},
): Promise<string> {
  let run = inflight.get(command);
  if (run === undefined) {
    run = runHelper(command, options.timeoutMs ?? API_KEY_HELPER_TIMEOUT_MS)
      .then((key) => remember(command, key))
      .finally(() => inflight.delete(command));
    inflight.set(command, run);
  }
  if (signal === undefined) return run;
  const shared = run;
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The key to send now: the cached one while it is fresh, otherwise a new run.
 * A refresh that fails falls back to the key it was replacing, which may well
 * still be accepted; a 401 on it comes back through `invalidateApiKeyHelper`.
 */
export async function getApiKeyFromHelper(
  command: string,
  signal?: AbortSignal,
  options: HelperRunOptions = {},
): Promise<string> {
  const entry = latest.get(command);
  if (entry !== undefined && isFresh(entry, Date.now())) return entry.key;
  try {
    return await refreshApiKeyHelper(command, signal, options);
  } catch (error) {
    if (entry !== undefined && !signal?.aborted) return entry.key;
    throw error;
  }
}

/**
 * Forget `rejectedKey` as the helper's current answer, so the next
 * `getApiKeyFromHelper` runs the command again. A key a concurrent refresh has
 * already replaced is left alone.
 */
export function invalidateApiKeyHelper(command: string, rejectedKey: string): void {
  if (latest.get(command)?.key === rejectedKey) latest.delete(command);
}

/** Drop every cached key (tests; a process that must forget its credentials). */
export function clearApiKeyHelperCache(): void {
  latest.clear();
  issuedBy.clear();
  inflight.clear();
  recentFailures.clear();
}
