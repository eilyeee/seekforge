/**
 * Environment scrubbing for agent-spawned processes.
 *
 * Commands the agent runs (including auto-allowlisted ones like `pnpm test` /
 * `make`) inherit the parent process env by default, which holds the provider
 * API key (DEEPSEEK_API_KEY / ARK_API_KEY) and any *_TOKEN the user exported.
 * redactSecrets only sanitizes captured stdout flowing back to the model; it
 * does nothing against a build script that reads $DEEPSEEK_API_KEY and POSTs it
 * out. So we pass spawned shells (and the runtime child, which then spawns its
 * own shells) a copy of the env with secret-bearing variables removed.
 *
 * A denylist (rather than an allowlist) so ordinary build/test env — NODE_ENV,
 * CI, CARGO_*, JAVA_HOME, proxy vars, PATH — keeps working; only variables that
 * look like a credential are dropped.
 */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIALS?/i,
  /PRIVATE[_-]?KEY/i,
  /SESSION[_-]?KEY/i,
  // Catches AWS_ACCESS_KEY_ID etc.; AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
  // are caught by the SECRET/TOKEN patterns. Deliberately NOT a blanket ^AWS_
  // so non-secret AWS_REGION / AWS_PROFILE a build needs are preserved.
  /ACCESS[_-]?KEY/i,
];

/** True when an env var name looks like it carries a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_PATTERNS.some((re) => re.test(name));
}

/**
 * Return a copy of `source` (default process.env) with secret-looking variables
 * removed, for use as the `env` of an agent-spawned child process.
 */
export function scrubSecretEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isSecretEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}
