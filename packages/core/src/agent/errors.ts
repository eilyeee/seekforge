/**
 * Agent error taxonomy — classifies a thrown error into a broad kind plus an
 * ACTIONABLE one-line hint. The loop appends the hint to session.failed's
 * error object, so every frontend (CLI/TUI/desktop/server) shows recovery
 * guidance with zero further wiring.
 *
 * Pure keyword/status matching over the error's code/status/message; no
 * provider types are imported so it works on any unknown throw site.
 */

export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "context_overflow"
  | "sandbox"
  | "tool"
  | "blocked"
  | "unknown";

export type ClassifiedAgentError = { kind: AgentErrorKind; hint: string };

const HINTS: Record<AgentErrorKind, string> = {
  auth: "Check your DeepSeek API key: `seekforge config set apiKey <key>` (or set DEEPSEEK_API_KEY) and verify the account is active.",
  rate_limit:
    "Provider rate limit hit — wait a moment and retry; reduce parallel runs or batch requests if this recurs.",
  network: "Could not reach the API — check your network/proxy (HTTPS_PROXY) and the configured baseUrl.",
  timeout: "The request timed out — retry; if it persists, check provider status or your connection.",
  context_overflow:
    "Context window exceeded — run /compact (or start a fresh session) to shrink the conversation before retrying.",
  sandbox:
    "The OS sandbox is unavailable or denied the operation — install the sandbox helper (sandbox-exec/bwrap) or rerun with sandbox off.",
  blocked: "A configured hook blocked this action — review your hooks in .seekforge/config.json.",
  tool: "A tool call failed — inspect the last tool error in the session trace (`seekforge sessions`) and adjust the task or arguments.",
  unknown: "Retry the task; inspect the session trace (`seekforge sessions`) for details.",
};

/**
 * Classify a thrown error. Precedence runs most-specific first (explicit
 * codes, then status, then keyword buckets) so e.g. "connection timed out"
 * lands on timeout rather than network and 429 quota text is rate_limit
 * rather than auth.
 */
export function classifyAgentError(err: unknown): ClassifiedAgentError {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = err instanceof Error ? err.message : typeof e?.message === "string" ? e.message : String(err ?? "");
  const text = `${code} ${message}`.toLowerCase();

  const pick = (kind: AgentErrorKind): ClassifiedAgentError => ({ kind, hint: HINTS[kind] });

  // Explicit codes from our own subsystems first.
  if (code === "blocked_by_hook" || code === "hook_blocked") return pick("blocked");
  if (
    code === "sandbox_unavailable" ||
    text.includes("sandbox") ||
    text.includes("seatbelt") ||
    text.includes("bwrap")
  ) {
    return pick("sandbox");
  }

  if (
    text.includes("context length") ||
    text.includes("context_length") ||
    text.includes("context window") ||
    text.includes("maximum tokens") ||
    text.includes("max tokens") ||
    text.includes("prompt is too long")
  ) {
    return pick("context_overflow");
  }

  if (
    status === 429 ||
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("quota")
  ) {
    return pick("rate_limit");
  }

  if (
    status === 401 ||
    status === 403 ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("api key") ||
    text.includes("authentication")
  ) {
    return pick("auth");
  }

  // Timeout before network: "connection timed out" is a timeout to retry,
  // not a broken route.
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborted")) {
    return pick("timeout");
  }

  if (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("econnreset") ||
    text.includes("fetch failed") ||
    text.includes("network error") ||
    text.includes("dns") ||
    text.includes("socket hang up")
  ) {
    return pick("network");
  }

  if (text.includes("tool")) return pick("tool");

  return pick("unknown");
}
