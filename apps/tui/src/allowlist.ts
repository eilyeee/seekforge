/**
 * Derives the command prefix added to the session allowlist when the user
 * picks "allow for the session" on a run_command permission request.
 */

/**
 * Returns the first two whitespace-collapsed tokens of the command — or just
 * the first when there is only one, or when the second token looks like a
 * flag (starts with "-") or a path/url (contains "/" or ":").
 *
 * Examples: "npm run build" → "npm run"; "ls -la" → "ls";
 * "git push origin main" → "git push"; "node scripts/x.js" → "node".
 */
export function sessionAllowPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== "");
  const first = tokens[0] ?? "";
  const second = tokens[1];
  if (second === undefined) return first;
  if (second.startsWith("-") || second.includes("/") || second.includes(":")) return first;
  return `${first} ${second}`;
}
