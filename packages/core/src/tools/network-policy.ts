/**
 * Domain allowlists for sandboxed commands (config `sandboxNetwork`) and the
 * host matching shared with `domain:` permission rules.
 *
 * Pure: no sockets here. The proxy that enforces a policy lives in
 * network-proxy.ts; the OS profile that forces traffic through it lives in
 * os-sandbox.ts.
 */
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/** The user-facing `sandboxNetwork` config value, after validation. */
export type SandboxNetworkPolicy = {
  /** `example.com` = exactly that host; `*.example.com` = any subdomain of it. */
  allowedDomains: readonly string[];
  /** Same pattern syntax; a denied host is refused even when an allow pattern matches. */
  deniedDomains?: readonly string[];
};

export class SandboxNetworkConfigError extends Error {}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Canonical form of a host name as it appears on the wire: lower case, no
 * trailing dot, IPv6 without brackets, IDN labels as punycode. Returns null
 * for something that is not a host at all, so a caller can refuse it.
 */
export function canonicalHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return null;
  if (isIP(host) !== 0) return host;
  // domainToASCII returns "" for input it cannot encode (spaces, "/", "@", …).
  const ascii = /^[\x00-\x7f]*$/.test(host) ? host : domainToASCII(host);
  if (ascii === "" || ascii.length > 253) return null;
  return ascii.split(".").every((label) => LABEL.test(label)) ? ascii : null;
}

/**
 * Validate one allow/deny pattern and return its canonical form. A pattern is
 * a host name, an IP literal, or `*.` followed by a host name with at least
 * two labels — `*.com` would be an allowlist in name only.
 */
export function parseDomainPattern(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SandboxNetworkConfigError(`sandboxNetwork domain must be a string, got ${JSON.stringify(raw)}`);
  }
  const wildcard = raw.trim().startsWith("*.");
  const body = wildcard ? raw.trim().slice(2) : raw;
  const host = canonicalHost(body);
  if (host === null || body.includes("*")) {
    throw new SandboxNetworkConfigError(
      `sandboxNetwork domain ${JSON.stringify(raw)} is not a host name ("example.com") or subdomain wildcard ("*.example.com") — schemes, ports and paths are not part of a domain`,
    );
  }
  if (wildcard && (isIP(host) !== 0 || !host.includes("."))) {
    throw new SandboxNetworkConfigError(
      `sandboxNetwork domain ${JSON.stringify(raw)} is too broad — a wildcard needs a registrable domain after "*."`,
    );
  }
  return wildcard ? `*.${host}` : host;
}

function parsePatternList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new SandboxNetworkConfigError(`sandboxNetwork.${key} must be an array of domain patterns`);
  }
  return [...new Set(value.map(parseDomainPattern))];
}

/**
 * Validate the raw `sandboxNetwork` config value. Throws instead of dropping a
 * malformed entry: a policy that silently lost its allowlist would leave the
 * sandbox at its level's default, which for `workspace-write` is the whole
 * network — the opposite of what the user wrote.
 */
export function parseSandboxNetworkPolicy(value: unknown): SandboxNetworkPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxNetworkConfigError("sandboxNetwork must be an object with an allowedDomains array");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "allowedDomains" && key !== "deniedDomains") {
      throw new SandboxNetworkConfigError(`sandboxNetwork has an unknown field ${JSON.stringify(key)}`);
    }
  }
  const allowedDomains = parsePatternList(record.allowedDomains, "allowedDomains");
  const deniedDomains =
    record.deniedDomains === undefined ? [] : parsePatternList(record.deniedDomains, "deniedDomains");
  return deniedDomains.length > 0 ? { allowedDomains, deniedDomains } : { allowedDomains };
}

/** A stable identity for a policy, so equal policies share one proxy. */
export function networkPolicyKey(policy: SandboxNetworkPolicy): string {
  const allowed = [...policy.allowedDomains].sort();
  const denied = [...(policy.deniedDomains ?? [])].sort();
  return JSON.stringify([allowed, denied]);
}

/** Pattern match: `example.com` is that host only, `*.example.com` its strict subdomains. */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const canonical = canonicalHost(host);
  if (canonical === null) return false;
  // An address has no subdomains: "10.0.0.1" merely ends with ".0.0.1".
  if (pattern.startsWith("*.")) return isIP(canonical) === 0 && canonical.endsWith(pattern.slice(1));
  return canonical === pattern;
}

/** `domain:` rule match: the host itself or any of its subdomains, on a label boundary. */
export function hostWithinDomain(host: string, domain: string): boolean {
  const canonical = canonicalHost(host);
  const root = canonicalHost(domain);
  if (canonical === null || root === null) return false;
  if (canonical === root) return true;
  return isIP(root) === 0 && isIP(canonical) === 0 && canonical.endsWith(`.${root}`);
}

export type NetworkRefusalReason = "denied" | "not_allowed" | "invalid_host" | "local_address";

/**
 * `exact` says the host is named by an allow entry itself, not only covered by
 * a wildcard — the difference between "the user listed this name" and "the
 * user trusted everyone who can create a name under this domain".
 */
export type NetworkDecision =
  | { allowed: true; exact: boolean }
  | { allowed: false; reason: Exclude<NetworkRefusalReason, "local_address"> };

export function decideHost(policy: SandboxNetworkPolicy, host: string): NetworkDecision {
  const canonical = canonicalHost(host);
  if (canonical === null) return { allowed: false, reason: "invalid_host" };
  if ((policy.deniedDomains ?? []).some((pattern) => hostMatchesPattern(host, pattern))) {
    return { allowed: false, reason: "denied" };
  }
  if (policy.allowedDomains.includes(canonical)) return { allowed: true, exact: true };
  return policy.allowedDomains.some((pattern) => hostMatchesPattern(host, pattern))
    ? { allowed: true, exact: false }
    : { allowed: false, reason: "not_allowed" };
}

function mappedIpv4(address: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Addresses that mean "this machine" or its link: loopback, unspecified, and
 * link-local (which includes the cloud metadata endpoint). Private ranges are
 * deliberately not here — a corporate registry legitimately resolves to one.
 */
export function isHostLocalAddress(raw: string): boolean {
  const address = raw
    .toLowerCase()
    .split("%")[0]!
    .replace(/^\[|\]$/g, "");
  const embedded = mappedIpv4(address);
  if (embedded !== undefined) return isHostLocalAddress(embedded);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (isIP(address) === 6) return address === "::1" || address === "::" || /^fe[89ab]/.test(address);
  return false;
}
