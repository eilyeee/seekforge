/**
 * Form model for the user-owned sandbox settings (`additionalDirectories`,
 * `sandboxNetwork`). Pure: the server validates each value with core's rules
 * and its 400 message is shown verbatim, so this only turns text into the
 * PUT /api/config value and back.
 */

/** One directory per line (paths may contain commas); blank lines dropped, duplicates removed. */
export function parseDirectoryLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry !== "" && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Domain patterns separated by newlines, commas or spaces; duplicates removed. */
export function parseDomainList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const entry = part.trim();
    if (entry !== "" && !out.includes(entry)) out.push(entry);
  }
  return out;
}

export function formatLines(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

export type SandboxNetworkValue = { allowedDomains: string[]; deniedDomains?: string[] } | null;

/**
 * The value to save. `enabled: false` clears the key (null): the sandbox level
 * alone decides network access. `enabled: true` with no allowed domains is a
 * real policy — no domain is reachable — not the same as clearing it.
 */
export function sandboxNetworkValue(enabled: boolean, allowedText: string, deniedText: string): SandboxNetworkValue {
  if (!enabled) return null;
  const allowedDomains = parseDomainList(allowedText);
  const deniedDomains = parseDomainList(deniedText);
  return deniedDomains.length > 0 ? { allowedDomains, deniedDomains } : { allowedDomains };
}
