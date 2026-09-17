/**
 * Loopback-only URLs for the Desktop preview panel. The panel frames local dev
 * servers and nothing else: a preview must never become a way to load an
 * arbitrary site inside the workbench window. Pure; unit-tested.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `http(s)://127.0.0.1|localhost|[::1]:<port>/...` normalized, or null for
 * anything else (other hosts, no explicit port, credentials, other schemes).
 * A bare `localhost:5173` or `:5173` is read as http.
 */
export function normalizeLoopbackUrl(input: string): string | null {
  let text = input.trim();
  if (text === "") return null;
  if (/^:\d+/.test(text)) text = `localhost${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username !== "" || url.password !== "") return null;
  const port = Number(url.port);
  if (url.port === "" || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return url.toString();
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d{1,5}(?:\/[^\s"'<>)\]]*)?/gi;
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/**
 * Loopback URLs mentioned in command output ("Local: http://localhost:5173/"),
 * newest last, de-duplicated. `0.0.0.0` (a bind address dev servers print) is
 * offered as 127.0.0.1, which is where it is reachable from here.
 */
export function detectLoopbackUrls(output: string, limit = 5): string[] {
  const found: string[] = [];
  for (const match of output.replace(ANSI_RE, "").matchAll(URL_IN_TEXT_RE)) {
    const candidate = normalizeLoopbackUrl(match[0].replace(/\/\/0\.0\.0\.0:/, "//127.0.0.1:").replace(/[.,;:]+$/, ""));
    if (!candidate) continue;
    const at = found.indexOf(candidate);
    if (at !== -1) found.splice(at, 1);
    found.push(candidate);
  }
  return found.slice(-limit);
}
