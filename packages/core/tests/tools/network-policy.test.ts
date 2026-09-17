import { describe, expect, it } from "vitest";
import {
  canonicalHost,
  decideHost,
  hostMatchesPattern,
  hostWithinDomain,
  isHostLocalAddress,
  networkPolicyKey,
  parseDomainPattern,
  parseSandboxNetworkPolicy,
  SandboxNetworkConfigError,
} from "../../src/tools/network-policy.js";

describe("canonicalHost", () => {
  it("lower-cases, drops a trailing dot and IPv6 brackets, and encodes IDN labels", () => {
    expect(canonicalHost("Docs.Example.COM.")).toBe("docs.example.com");
    expect(canonicalHost("[::1]")).toBe("::1");
    expect(canonicalHost("bücher.de")).toBe("xn--bcher-kva.de");
    expect(canonicalHost("10.0.0.1")).toBe("10.0.0.1");
  });

  it("refuses things that are not a host", () => {
    for (const bad of [
      "",
      "example.com:443",
      "https://example.com",
      "a b.com",
      "user@host",
      "example.com/x",
      "-bad.com",
    ]) {
      expect(canonicalHost(bad), bad).toBeNull();
    }
  });
});

describe("parseSandboxNetworkPolicy", () => {
  it("accepts hosts, IP literals and subdomain wildcards, canonicalized and de-duplicated", () => {
    expect(
      parseSandboxNetworkPolicy({
        allowedDomains: ["Registry.npmjs.org", "*.GitHub.com", "registry.npmjs.org", "127.0.0.1"],
        deniedDomains: ["gist.github.com"],
      }),
    ).toEqual({
      allowedDomains: ["registry.npmjs.org", "*.github.com", "127.0.0.1"],
      deniedDomains: ["gist.github.com"],
    });
    expect(parseSandboxNetworkPolicy({ allowedDomains: [] })).toEqual({ allowedDomains: [] });
    expect(parseSandboxNetworkPolicy({ allowedDomains: ["a.dev"], deniedDomains: [] })).toEqual({
      allowedDomains: ["a.dev"],
    });
  });

  it("throws on anything malformed instead of dropping it", () => {
    const bad: unknown[] = [
      null,
      [],
      "example.com",
      {},
      { allowedDomains: "example.com" },
      { allowedDomains: ["https://example.com"] },
      { allowedDomains: ["example.com:443"] },
      { allowedDomains: ["*"] },
      { allowedDomains: ["*.com"] },
      { allowedDomains: ["*.10.0.0.1"] },
      { allowedDomains: ["a.*.example.com"] },
      { allowedDomains: [42] },
      { allowedDomains: ["example.com"], deniedDomains: "x" },
      { allowedDomains: ["example.com"], allowLocal: true },
    ];
    for (const value of bad) {
      expect(() => parseSandboxNetworkPolicy(value), JSON.stringify(value)).toThrow(SandboxNetworkConfigError);
    }
    expect(() => parseDomainPattern("*.example.com/x")).toThrow(/not a host name/);
  });

  it("keys equal policies identically regardless of order", () => {
    expect(networkPolicyKey({ allowedDomains: ["b", "a"] })).toBe(networkPolicyKey({ allowedDomains: ["a", "b"] }));
    expect(networkPolicyKey({ allowedDomains: ["a"] })).not.toBe(
      networkPolicyKey({ allowedDomains: ["a"], deniedDomains: ["a"] }),
    );
  });
});

describe("isHostLocalAddress", () => {
  it("covers loopback, unspecified and link-local in every spelling, and nothing else", () => {
    for (const local of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "169.254.169.254",
      "::1",
      "::",
      "[::1]",
      "fe80::1%en0",
      "FEBF::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::127.0.0.1",
    ]) {
      expect(isHostLocalAddress(local), local).toBe(true);
    }
    for (const remote of [
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "8.8.8.8",
      "fd00::1",
      "2001:db8::1",
      "::ffff:8.8.8.8",
      "localhost",
    ]) {
      expect(isHostLocalAddress(remote), remote).toBe(false);
    }
  });
});

describe("host matching", () => {
  it("an exact pattern is that host only; a wildcard is strict subdomains on a label boundary", () => {
    expect(hostMatchesPattern("example.com", "example.com")).toBe(true);
    expect(hostMatchesPattern("EXAMPLE.com.", "example.com")).toBe(true);
    expect(hostMatchesPattern("api.example.com", "example.com")).toBe(false);
    expect(hostMatchesPattern("api.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("a.b.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("evilexample.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("example.com.evil.net", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("not a host", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("10.0.0.1", "*.0.0.1")).toBe(false);
  });

  it("a domain rule covers the host and its subdomains, never a lookalike", () => {
    expect(hostWithinDomain("docs.example.com", "example.com")).toBe(true);
    expect(hostWithinDomain("example.com", "example.com")).toBe(true);
    expect(hostWithinDomain("docs.example.com.evil.net", "docs.example.com")).toBe(false);
    expect(hostWithinDomain("notexample.com", "example.com")).toBe(false);
    expect(hostWithinDomain("10.0.0.1", "0.0.1")).toBe(false);
  });

  it("decides deny before allow and refuses invalid hosts", () => {
    const policy = {
      allowedDomains: ["*.example.com", "exact.example.com", "10.0.0.1"],
      deniedDomains: ["secret.example.com"],
    };
    expect(decideHost(policy, "api.example.com")).toEqual({ allowed: true, exact: false });
    expect(decideHost(policy, "EXACT.example.com.")).toEqual({ allowed: true, exact: true });
    expect(decideHost(policy, "10.0.0.1")).toEqual({ allowed: true, exact: true });
    expect(decideHost(policy, "secret.example.com")).toEqual({ allowed: false, reason: "denied" });
    expect(decideHost(policy, "other.net")).toEqual({ allowed: false, reason: "not_allowed" });
    expect(decideHost(policy, "user@api.example.com")).toEqual({ allowed: false, reason: "invalid_host" });
  });
});
