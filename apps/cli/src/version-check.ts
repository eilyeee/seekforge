// Non-blocking "new version available" notifier for the published `seekforge`
// package. Fire-and-forget: NEVER throws, NEVER blocks startup. Hits the npm
// registry at most once per 24h; otherwise serves a cached result.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dim, useColor } from "./colors.js";
import { readTextFileBounded } from "./bounded-file.js";

const REGISTRY_URL = "https://registry.npmjs.org/seekforge/latest";
const PACKAGE_NAME = "seekforge";
const FETCH_TIMEOUT_MS = 2000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const MAX_UPDATE_CACHE_BYTES = 64 * 1024;

/** Path to the update-check cache (~/.seekforge/update-check.json). */
function cachePath(): string {
  return join(homedir(), ".seekforge", "update-check.json");
}

type CacheEntry = {
  /** Epoch ms of the last successful network check. */
  checkedAt: number;
  /** The version reported by the registry at that time. */
  latest: string;
};

/**
 * Pure semver comparison: is `a` strictly newer than `b`?
 *
 * Compares the numeric major.minor.patch only. Prerelease/build metadata is
 * ignored for the comparison itself, EXCEPT that a prerelease is treated as
 * OLDER than the same release (e.g. 0.8.0-rc.1 is NOT newer than 0.8.0, and
 * 0.8.0 IS newer than 0.8.0-rc.1) — matching semver precedence and keeping
 * users off pre-releases. Unparseable input yields false (no false positives).
 */
export function isNewer(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const da = pa.core[i] ?? 0;
    const db = pb.core[i] ?? 0;
    if (da !== db) return da > db;
  }
  // Same core version: a release outranks a prerelease.
  if (pa.prerelease === pb.prerelease) return false;
  return !pa.prerelease && pb.prerelease;
}

function parseSemver(v: string): { core: [number, number, number]; prerelease: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: Boolean(m[4]),
  };
}

/**
 * Decide whether the cache is fresh enough to skip the network. Pure so it can
 * be unit-tested without touching disk.
 */
export function isCacheFresh(entry: CacheEntry | null, now: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!entry) return false;
  if (!Number.isFinite(entry.checkedAt) || !Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs < 0) {
    return false;
  }
  return now - entry.checkedAt < intervalMs;
}

function readCache(): CacheEntry | null {
  try {
    const raw = JSON.parse(readTextFileBounded(cachePath(), MAX_UPDATE_CACHE_BYTES)) as Partial<CacheEntry>;
    if (typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt) && typeof raw.latest === "string") {
      return { checkedAt: raw.checkedAt, latest: raw.latest };
    }
  } catch {
    // missing/corrupt cache → treat as no cache
  }
  return null;
}

function writeCache(entry: CacheEntry): void {
  try {
    const file = cachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entry));
  } catch {
    // a failed cache write must never affect the caller
  }
}

/**
 * Returns the newer published version string if one exists, else null.
 * Network is hit at most once per 24h; otherwise the cached version is used.
 * Guaranteed non-throwing.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const now = Date.now();
    const cached = readCache();

    if (isCacheFresh(cached, now)) {
      return cached && isNewer(cached.latest, currentVersion) ? cached.latest : null;
    }

    const latest = await fetchLatest();
    if (!latest) {
      // Network failed: fall back to any cached value rather than nothing.
      return cached && isNewer(cached.latest, currentVersion) ? cached.latest : null;
    }

    writeCache({ checkedAt: now, latest });
    return isNewer(latest, currentVersion) ? latest : null;
  } catch {
    return null;
  }
}

/** GET the latest version from the npm registry with a hard 2s timeout. */
async function fetchLatest(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One dim line, e.g. "↑ seekforge 0.8.0 available (you have 0.7.0) — npm i -g
 * seekforge". The notice prints to stderr; dim it only when stderr is a TTY and
 * NO_COLOR is unset (it is suppressed entirely in machine modes upstream).
 */
export function formatUpdateNotice(latest: string, current: string): string {
  const enabled = useColor({ isTTY: Boolean(process.stderr.isTTY) });
  return dim(`↑ ${PACKAGE_NAME} ${latest} available (you have ${current}) — npm i -g ${PACKAGE_NAME}`, enabled);
}
