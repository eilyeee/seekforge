/**
 * Whether this process's HTTP requests can use the proxy the environment
 * names, as a doctor line.
 *
 * Node's fetch (provider, MCP over HTTP, web_search, telemetry) only follows
 * HTTP(S)_PROXY when the process started with --use-env-proxy or
 * NODE_USE_ENV_PROXY=1; the `seekforge` launcher adds the flag itself where
 * Node can take it (apps/cli/bin/env-proxy.js). This says which case applies.
 * web_fetch is the exception on purpose: it connects to the address it
 * validated, proxy or not.
 */

import { existsSync } from "node:fs";
import type { DoctorCheck } from "@seekforge/shared/doctor";

export type ProxyProbe = {
  env: Record<string, string | undefined>;
  execArgv: readonly string[];
  allowedFlags: ReadonlySet<string>;
  nodeVersion: string;
  platform: string;
  fileExists?: (path: string) => boolean;
};

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

function set(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function flagOn(args: readonly string[], flag: string): boolean | undefined {
  let state: boolean | undefined;
  for (const arg of args) {
    if (arg === flag || arg.startsWith(`${flag}=`)) state = true;
    else if (arg === flag.replace(/^--/, "--no-")) state = false;
  }
  return state;
}

/** The proxy/CA line for `doctor`; undefined when nothing proxy- or CA-related is configured. */
export function proxyDoctorCheck(probe: ProxyProbe): DoctorCheck | undefined {
  const { env } = probe;
  const exists = probe.fileExists ?? existsSync;
  const proxyVars = PROXY_VARIABLES.filter((name) => set(env[name]));
  const notes: string[] = [];
  const caFile = env["NODE_EXTRA_CA_CERTS"];
  if (set(caFile)) {
    if (!exists(caFile)) {
      return {
        name: "proxy",
        ok: true,
        warn: true,
        detail: `NODE_EXTRA_CA_CERTS points to a missing file (${caFile})`,
        fixHint: "Point NODE_EXTRA_CA_CERTS at a PEM bundle; Node reads it only at startup.",
      };
    }
    notes.push("extra CA certificates from NODE_EXTRA_CA_CERTS");
  }

  if (proxyVars.length === 0) {
    if (set(env["ALL_PROXY"]) || set(env["all_proxy"])) {
      return {
        name: "proxy",
        ok: true,
        warn: true,
        detail: "ALL_PROXY is set, but Node does not read it; requests go direct",
        fixHint: "Set HTTPS_PROXY / HTTP_PROXY to an http:// proxy (SOCKS is not supported).",
      };
    }
    return notes.length > 0 ? { name: "proxy", ok: true, detail: `no proxy; ${notes.join(", ")}` } : undefined;
  }

  const nodeOptions = (env["NODE_OPTIONS"] ?? "").split(/\s+/);
  const byFlag = flagOn([...nodeOptions, ...probe.execArgv], "--use-env-proxy");
  const active = byFlag ?? env["NODE_USE_ENV_PROXY"] === "1";
  const named = proxyVars.join("/");
  if (active) {
    const noProxy = env["NO_PROXY"] ?? env["no_proxy"];
    notes.unshift(
      `requests use ${named}`,
      set(noProxy) ? `NO_PROXY=${noProxy}` : "no NO_PROXY: loopback is proxied too",
    );
    return { name: "proxy", ok: true, detail: notes.join("; ") };
  }
  if (!probe.allowedFlags.has("--use-env-proxy")) {
    return {
      name: "proxy",
      ok: true,
      warn: true,
      detail: `${named} is set, but Node ${probe.nodeVersion} cannot send fetch through a proxy; requests go direct`,
      fixHint: "Use Node 22.21+ or 24.5+, which honor HTTP(S)_PROXY with --use-env-proxy.",
    };
  }
  return {
    name: "proxy",
    ok: true,
    warn: true,
    detail: `${named} is set, but this process was not started with --use-env-proxy; requests go direct`,
    fixHint:
      env["NODE_USE_ENV_PROXY"] !== undefined
        ? "NODE_USE_ENV_PROXY is set to something other than 1; set it to 1, or unset it and start through the seekforge launcher."
        : probe.platform === "win32"
          ? "Set NODE_USE_ENV_PROXY=1 (the launcher cannot restart itself with the flag on Windows)."
          : "Start through the `seekforge` / `seekforge-tui` launcher, or set NODE_USE_ENV_PROXY=1.",
  };
}
