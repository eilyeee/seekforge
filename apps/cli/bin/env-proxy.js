/**
 * Make Node's fetch honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
 *
 * Node's fetch ignores those variables unless the process *started* with
 * `--use-env-proxy` (or NODE_USE_ENV_PROXY=1); setting either later does
 * nothing. So when a proxy variable is set and this Node supports the flag,
 * the launcher replaces itself — same PID, same terminal, same arguments —
 * with a Node started that way. `process.execve` rather than a child process:
 * a parent left waiting would receive the terminal's Ctrl+C alongside the
 * child, and the CLI reads a second Ctrl+C as "force quit".
 *
 * Inert unless a proxy variable is set. Skipped when the user already chose
 * (NODE_USE_ENV_PROXY set to anything, or the flag present), and where the
 * running Node lacks `process.execve` (Windows; added in 22.15 / 23.11) or the
 * flag (added in 22.21 / 24.5) — both detected, not inferred from a version.
 * A flag, not the environment variable, so the commands the agent runs keep
 * their own proxy behavior.
 *
 * Plain JavaScript beside the bins: it runs before the bundle is loaded.
 */

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
/**
 * Node's proxy agent does not exempt loopback on its own, so without this a
 * local Ollama, MCP server or OTLP collector would be sent to the proxy. IPv6
 * must be bracketed for Node to match it.
 */
export const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";
const PROXY_FLAG = /^--(?:no-)?use-env-proxy(?:=|$)/;

/**
 * @param {{
 *   env: Record<string, string | undefined>;
 *   execArgv: readonly string[];
 *   argv: readonly string[];
 *   execPath: string;
 *   allowedFlags: ReadonlySet<string>;
 *   hasExecve: boolean;
 * }} proc
 * @returns {{ file: string; args: string[]; env: Record<string, string | undefined> } | null}
 */
export function envProxyRelaunch(proc) {
  const { env } = proc;
  if (!PROXY_VARIABLES.some((name) => (env[name] ?? "").trim() !== "")) return null;
  if (env.NODE_USE_ENV_PROXY !== undefined) return null;
  const nodeOptions = (env.NODE_OPTIONS ?? "").split(/\s+/);
  if ([...proc.execArgv, ...nodeOptions].some((arg) => PROXY_FLAG.test(arg))) return null;
  if (!proc.hasExecve || !proc.allowedFlags.has("--use-env-proxy")) return null;
  const flags = ["--use-env-proxy"];
  // The proxy agent announces itself as experimental on every start.
  if (proc.allowedFlags.has("--disable-warning")) flags.push("--disable-warning=UNDICI-EHPA");
  const nextEnv = { ...env };
  if (nextEnv.NO_PROXY === undefined && nextEnv.no_proxy === undefined) nextEnv.NO_PROXY = LOOPBACK_NO_PROXY;
  return {
    file: proc.execPath,
    args: [proc.execPath, ...flags, ...proc.execArgv, ...proc.argv.slice(1)],
    env: nextEnv,
  };
}

/** Replace this process with a proxy-aware Node when that is needed and possible; otherwise return. */
export function relaunchWithEnvProxy() {
  const plan = envProxyRelaunch({
    env: process.env,
    execArgv: process.execArgv,
    argv: process.argv,
    execPath: process.execPath,
    allowedFlags: process.allowedNodeEnvironmentFlags,
    hasExecve: typeof process.execve === "function",
  });
  if (plan === null) return;
  // Before Node 26.1 a failed execve aborts instead of throwing. The target is
  // the binary already running with the arguments it was given, so that needs
  // a system that could not have started this process either.
  try {
    process.execve(plan.file, plan.args, plan.env);
  } catch {
    // Carry on without the proxy rather than not at all; `seekforge doctor` says why requests may fail.
  }
}
