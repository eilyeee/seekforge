/**
 * Plugin marketplaces: named catalogs (Claude Code's `marketplace.json`) that
 * map plugin names to sources, so `seekforge plugin install <name>@<market>`
 * can resolve a plugin without the user typing its URL.
 *
 * A marketplace only answers "where is plugin X". It grants nothing: every
 * install it resolves goes through the same staging, validation and
 * disabled-until-approved flow as a direct install, and an entry that asks to
 * run something (`npm`, `command` sources) is refused rather than executed.
 *
 * Registry: `~/.seekforge/plugin-marketplaces.json` (user-owned state). Git
 * marketplaces are shallow-cloned into `~/.seekforge/plugin-marketplaces/<name>/`
 * at add time (history removed, commit recorded); local ones are read from
 * their directory whenever they are used.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { acquireSessionLease } from "../agent/session-lease.js";
import { seekforgeHome } from "../memory/store.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { PLUGIN_ID_RE } from "./load.js";
import {
  type ArchiveFormat,
  classifyRemoteUrl,
  cloneShallow,
  confinedDirectory,
  createStagingDir,
  redactSourceUrl,
  seekforgeStateDir,
  validateGitRef,
  validateGitSha,
} from "./source.js";

export const MARKETPLACE_REGISTRY_REL_PATH = ".seekforge/plugin-marketplaces.json";
export const MARKETPLACES_MUTATION_LEASE_ID = "plugin-marketplaces-mutation";
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_MARKETPLACE_MANIFEST_BYTES = 1024 * 1024;
const MAX_MARKETPLACE_PLUGINS = 1_000;

export type MarketplaceRecord = {
  name: string;
  kind: "local" | "git";
  /** Absolute directory (local) or credential-free clone URL (git). */
  source: string;
  ref?: string;
  /** The commit the cached copy was cloned at (git only). */
  commit?: string;
  addedAt: string;
};

type MarketplaceRegistry = { version: 1; marketplaces: Record<string, MarketplaceRecord> };

/** Where one marketplace entry's plugin lives. */
export type MarketplaceEntrySource =
  | { kind: "relative"; path: string }
  | { kind: "git"; url: string; ref?: string; sha?: string; subdir?: string }
  | { kind: "archive"; url: string; format?: ArchiveFormat; sha256?: string; subdir?: string };

export type MarketplacePluginEntry = {
  name: string;
  description?: string;
  version?: string;
  source: MarketplaceEntrySource;
};

export type MarketplaceManifest = {
  name: string;
  description?: string;
  plugins: MarketplacePluginEntry[];
  /** Entries that could not be used, with the reason (reported, not fatal). */
  issues: string[];
};

export type MarketplaceListing = MarketplaceRecord & {
  root: string;
  plugins?: MarketplacePluginEntry[];
  issues?: string[];
  error?: string;
};

const recordSchema = z
  .object({
    name: z.string().regex(PLUGIN_ID_RE),
    kind: z.enum(["local", "git"]),
    source: z.string().min(1).max(4096),
    ref: z.string().max(200).optional(),
    commit: z.string().max(64).optional(),
    addedAt: z.string().max(64),
  })
  .strict();
const registrySchema = z
  .object({ version: z.literal(1), marketplaces: z.record(z.string().regex(PLUGIN_ID_RE), recordSchema) })
  .strict();

const manifestSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    metadata: z
      .object({
        pluginRoot: z.string().max(512).optional(),
        description: z.string().max(2_000).optional(),
      })
      .passthrough()
      .optional(),
    plugins: z.array(z.unknown()).max(MAX_MARKETPLACE_PLUGINS),
  })
  .passthrough();
const entrySchema = z
  .object({
    name: z.string().min(1).max(120),
    source: z.union([z.string().min(1).max(4096), z.object({ source: z.string().max(64) }).passthrough()]),
    description: z.string().max(2_000).optional(),
    version: z.string().max(100).optional(),
  })
  .passthrough();
const remoteFields = {
  ref: z.string().max(200).optional(),
  sha: z.string().max(64).optional(),
  path: z.string().max(512).optional(),
};
const githubSourceSchema = z
  .object({
    source: z.literal("github"),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    ...remoteFields,
  })
  .passthrough();
const urlSourceSchema = z
  .object({ source: z.enum(["url", "git"]), url: z.string().min(1).max(4096), ...remoteFields })
  .passthrough();
const archiveSourceSchema = z
  .object({
    source: z.literal("archive"),
    url: z.string().min(1).max(4096),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    path: z.string().max(512).optional(),
  })
  .passthrough();

function marketplacesCacheRoot(): string {
  return join(seekforgeHome(), ".seekforge", "plugin-marketplaces");
}

function requireMarketplaceName(name: string): string {
  if (!PLUGIN_ID_RE.test(name)) {
    throw new Error(`invalid marketplace name "${name}": use lowercase letters, digits and dashes`);
  }
  return name;
}

function readRegistry(): MarketplaceRegistry {
  const raw = readWorkspaceStateFile(seekforgeHome(), MARKETPLACE_REGISTRY_REL_PATH, MAX_REGISTRY_BYTES);
  if (raw === undefined) return { version: 1, marketplaces: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${MARKETPLACE_REGISTRY_REL_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = registrySchema.safeParse(value);
  if (!parsed.success) {
    // Refuse to rewrite a registry this version cannot read: overwriting it
    // would silently drop the marketplaces it holds.
    throw new Error(`${MARKETPLACE_REGISTRY_REL_PATH} is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  }
  for (const [key, record] of Object.entries(parsed.data.marketplaces)) {
    if (record.name !== key) throw new Error(`${MARKETPLACE_REGISTRY_REL_PATH}: entry ${key} names ${record.name}`);
  }
  return parsed.data as MarketplaceRegistry;
}

function writeRegistry(registry: MarketplaceRegistry): void {
  writeWorkspaceStateFileAtomic(
    seekforgeHome(),
    MARKETPLACE_REGISTRY_REL_PATH,
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

function withMarketplaceLease<T>(operation: () => T): T {
  const lease = acquireSessionLease(seekforgeHome(), MARKETPLACES_MUTATION_LEASE_ID);
  try {
    return operation();
  } finally {
    lease.release();
  }
}

/** Hold the marketplace lease across an async install so the cache cannot change under it. */
export async function withMarketplaceLeaseAsync<T>(operation: () => Promise<T>): Promise<T> {
  const lease = acquireSessionLease(seekforgeHome(), MARKETPLACES_MUTATION_LEASE_ID);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

/** The manifest file of a marketplace checkout, Claude Code's location first. */
function manifestRelPath(root: string): string {
  for (const candidate of [".claude-plugin/marketplace.json", "marketplace.json"]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  throw new Error(`no .claude-plugin/marketplace.json or marketplace.json in ${root}`);
}

function parseEntrySource(raw: unknown, pluginRoot: string | undefined): MarketplaceEntrySource {
  if (typeof raw === "string") {
    const remote = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(raw);
    if (remote) {
      const classified = classifyRemoteUrl(raw);
      return classified.kind === "git"
        ? { kind: "git", url: classified.url, ...(classified.ref ? { ref: classified.ref } : {}) }
        : { kind: "archive", url: classified.url, format: classified.format };
    }
    if (raw.startsWith("/") || raw.startsWith("~") || raw.includes("\\")) {
      throw new Error(`source must be a path relative to the marketplace: ${raw}`);
    }
    const joined = posix.normalize(posix.join(pluginRoot ?? ".", raw));
    if (joined === ".." || joined.startsWith("../")) throw new Error(`source escapes the marketplace: ${raw}`);
    return { kind: "relative", path: joined };
  }
  const kind = (raw as { source?: unknown }).source;
  if (kind === "github") {
    const parsed = githubSourceSchema.parse(raw);
    return {
      kind: "git",
      url: `https://github.com/${parsed.repo.replace(/\.git$/, "")}.git`,
      ...(parsed.ref !== undefined ? { ref: validateGitRef(parsed.ref) } : {}),
      ...(parsed.sha !== undefined ? { sha: validateGitSha(parsed.sha) } : {}),
      ...(parsed.path !== undefined ? { subdir: parsed.path } : {}),
    };
  }
  if (kind === "url" || kind === "git") {
    const parsed = urlSourceSchema.parse(raw);
    const classified = classifyRemoteUrl(parsed.url, { forceGit: kind === "git" });
    if (classified.kind === "archive") {
      if (parsed.ref !== undefined || parsed.sha !== undefined)
        throw new Error("an archive source takes no ref or sha");
      return {
        kind: "archive",
        url: classified.url,
        format: classified.format,
        ...(parsed.path !== undefined ? { subdir: parsed.path } : {}),
      };
    }
    if (classified.ref !== undefined && parsed.ref !== undefined) throw new Error("give the ref either as #ref or ref");
    const ref = parsed.ref !== undefined ? validateGitRef(parsed.ref) : classified.ref;
    return {
      kind: "git",
      url: classified.url,
      ...(ref !== undefined ? { ref } : {}),
      ...(parsed.sha !== undefined ? { sha: validateGitSha(parsed.sha) } : {}),
      ...(parsed.path !== undefined ? { subdir: parsed.path } : {}),
    };
  }
  if (kind === "archive") {
    const parsed = archiveSourceSchema.parse(raw);
    let url: URL;
    try {
      url = new URL(parsed.url);
    } catch {
      throw new Error(`invalid archive URL: ${parsed.url}`);
    }
    if (url.protocol !== "https:") throw new Error(`archive sources must use https: ${redactSourceUrl(parsed.url)}`);
    const suffix = url.pathname.toLowerCase();
    const format: ArchiveFormat | undefined =
      suffix.endsWith(".tar.gz") || suffix.endsWith(".tgz") ? "tar.gz" : suffix.endsWith(".zip") ? "zip" : undefined;
    return {
      kind: "archive",
      url: url.href,
      ...(format !== undefined ? { format } : {}),
      ...(parsed.sha256 !== undefined ? { sha256: parsed.sha256.toLowerCase() } : {}),
      ...(parsed.path !== undefined ? { subdir: parsed.path } : {}),
    };
  }
  // npm and command sources would run a package manager or an arbitrary
  // command the marketplace chose; neither is something a catalog may trigger.
  throw new Error(`unsupported source type ${JSON.stringify(kind ?? null)}`);
}

/** Read and validate a marketplace manifest from a checkout or local directory. */
export function readMarketplaceManifest(root: string): MarketplaceManifest {
  const physicalRoot = realpathSync(root);
  const rel = manifestRelPath(physicalRoot);
  const raw = readWorkspaceStateFile(physicalRoot, rel, MAX_MARKETPLACE_MANIFEST_BYTES);
  if (raw === undefined) throw new Error(`marketplace manifest disappeared: ${rel}`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${rel} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${rel}: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  const pluginRoot = parsed.data.metadata?.pluginRoot;
  const plugins: MarketplacePluginEntry[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  parsed.data.plugins.forEach((item, index) => {
    const entry = entrySchema.safeParse(item);
    if (!entry.success) {
      issues.push(`plugins[${index}]: ${entry.error.issues[0]?.message ?? "invalid entry"}`);
      return;
    }
    const { name } = entry.data;
    if (!PLUGIN_ID_RE.test(name)) {
      issues.push(`plugins[${index}] (${name}): name must use lowercase letters, digits and dashes`);
      return;
    }
    if (seen.has(name)) {
      issues.push(`plugins[${index}] (${name}): duplicate plugin name`);
      return;
    }
    try {
      const source = parseEntrySource(entry.data.source, pluginRoot);
      seen.add(name);
      plugins.push({
        name,
        ...(entry.data.description !== undefined ? { description: entry.data.description } : {}),
        ...(entry.data.version !== undefined ? { version: entry.data.version } : {}),
        source,
      });
    } catch (error) {
      const message =
        error instanceof z.ZodError ? (error.issues[0]?.message ?? "invalid source") : (error as Error).message;
      issues.push(`plugins[${index}] (${name}): ${message}`);
    }
  });
  return {
    name: parsed.data.name,
    ...((parsed.data.description ?? parsed.data.metadata?.description) !== undefined
      ? { description: parsed.data.description ?? parsed.data.metadata?.description }
      : {}),
    plugins,
    issues,
  };
}

function recordRoot(record: MarketplaceRecord): string {
  return record.kind === "local" ? record.source : join(marketplacesCacheRoot(), record.name);
}

/** Replace `target` with `incoming` so a failed swap never leaves the name empty. */
function swapIntoPlace(incoming: string, target: string): void {
  const old = join(dirname(target), `.old-${basename(target)}-${randomUUID()}`);
  const existed = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  if (existed) renameSync(target, old);
  try {
    renameSync(incoming, target);
  } catch (error) {
    if (existed) renameSync(old, target);
    throw error;
  }
  if (existed) rmSync(old, { recursive: true, force: true });
}

export type AddMarketplaceOptions = { name?: string; force?: boolean; signal?: AbortSignal; cwd?: string };

/** Register a local directory or a git repository as a marketplace. */
export async function addMarketplace(source: string, opts: AddMarketplaceOptions = {}): Promise<MarketplaceListing> {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed.startsWith("-")) throw new Error(`invalid marketplace source: ${source}`);
  if (opts.name !== undefined) requireMarketplaceName(opts.name);
  const localPath = resolve(opts.cwd ?? process.cwd(), trimmed);
  const isUrl = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !existsSync(localPath);
  if (!isUrl && existsSync(localPath)) {
    const root = realpathSync(localPath);
    if (!lstatSync(root).isDirectory()) throw new Error(`marketplace source is not a directory: ${trimmed}`);
    const manifest = readMarketplaceManifest(root);
    const name = requireMarketplaceName(opts.name ?? manifest.name);
    return withMarketplaceLease(() => {
      const registry = readRegistry();
      if (registry.marketplaces[name] && !opts.force) {
        throw new Error(`marketplace ${name} already exists; use --force to replace it`);
      }
      const record: MarketplaceRecord = { name, kind: "local", source: root, addedAt: new Date().toISOString() };
      // A name that used to be a git marketplace leaves a cache behind.
      removeCache(name);
      registry.marketplaces[name] = record;
      writeRegistry(registry);
      return { ...record, root, plugins: manifest.plugins, issues: manifest.issues };
    });
  }
  if (!isUrl && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(trimmed)) {
    throw new Error(`marketplace source not found: ${trimmed} (expected a local directory or a git URL)`);
  }
  const remote = classifyRemoteUrl(trimmed);
  if (remote.kind !== "git") throw new Error("a marketplace must be a local directory or a git repository URL");
  const staging = createStagingDir("plugin-marketplaces");
  try {
    const checkout = join(staging.path, "checkout");
    const commit = await cloneShallow(remote.url, checkout, {
      ...(remote.ref !== undefined ? { ref: remote.ref } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const manifest = readMarketplaceManifest(checkout);
    const name = requireMarketplaceName(opts.name ?? manifest.name);
    return withMarketplaceLease(() => {
      const registry = readRegistry();
      if (registry.marketplaces[name] && !opts.force) {
        throw new Error(`marketplace ${name} already exists; use --force to replace it`);
      }
      const target = join(seekforgeStateDir("plugin-marketplaces", true)!, name);
      swapIntoPlace(checkout, target);
      const record: MarketplaceRecord = {
        name,
        kind: "git",
        source: redactSourceUrl(remote.url),
        ...(remote.ref !== undefined ? { ref: remote.ref } : {}),
        commit,
        addedAt: new Date().toISOString(),
      };
      registry.marketplaces[name] = record;
      writeRegistry(registry);
      return { ...record, root: target, plugins: manifest.plugins, issues: manifest.issues };
    });
  } finally {
    staging.cleanup();
  }
}

/** Unregister a marketplace and delete its cached checkout. Installed plugins stay installed. */
export function removeMarketplace(name: string): { name: string; removedCache: boolean } {
  requireMarketplaceName(name);
  return withMarketplaceLease(() => {
    const registry = readRegistry();
    if (!registry.marketplaces[name]) throw new Error(`marketplace ${name} is not registered`);
    delete registry.marketplaces[name];
    writeRegistry(registry);
    return { name, removedCache: removeCache(name) };
  });
}

/** Delete a cached checkout through a physically validated cache root. */
function removeCache(name: string): boolean {
  const root = seekforgeStateDir("plugin-marketplaces", false);
  if (root === undefined) return false;
  const cache = join(root, name);
  if (lstatSync(cache, { throwIfNoEntry: false }) === undefined) return false;
  // Renamed first so a half-deleted tree never sits under a registered name.
  const trash = join(root, `.removed-${name}-${randomUUID()}`);
  renameSync(cache, trash);
  rmSync(trash, { recursive: true, force: true });
  return true;
}

/** Every registered marketplace with its current catalog (or the error reading it). */
export function listMarketplaces(): MarketplaceListing[] {
  const registry = readRegistry();
  return Object.values(registry.marketplaces)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((record) => {
      const root = recordRoot(record);
      try {
        const manifest = readMarketplaceManifest(root);
        return { ...record, root, plugins: manifest.plugins, issues: manifest.issues };
      } catch (error) {
        return { ...record, root, error: error instanceof Error ? error.message : String(error) };
      }
    });
}

export type ResolvedMarketplacePlugin = {
  record: MarketplaceRecord;
  root: string;
  entry: MarketplacePluginEntry;
  /** For a relative entry: the confined physical directory inside `root`. */
  localDir?: string;
};

/** Find `plugin` in marketplace `marketplace`; relative sources are resolved and confined. */
export function resolveMarketplacePlugin(plugin: string, marketplace: string): ResolvedMarketplacePlugin {
  requireMarketplaceName(marketplace);
  const record = readRegistry().marketplaces[marketplace];
  if (!record) {
    throw new Error(`unknown marketplace "${marketplace}"; add it with: seekforge plugin marketplace add <source>`);
  }
  const root = recordRoot(record);
  const manifest = readMarketplaceManifest(root);
  const entry = manifest.plugins.find((candidate) => candidate.name === plugin);
  if (!entry) {
    const issue = manifest.issues.find((text) => text.includes(`(${plugin})`));
    throw new Error(
      issue
        ? `marketplace ${marketplace} lists ${plugin} but it cannot be used: ${issue}`
        : `marketplace ${marketplace} has no plugin named ${plugin}`,
    );
  }
  if (entry.source.kind !== "relative") return { record, root, entry };
  return {
    record,
    root,
    entry,
    localDir: confinedDirectory(root, entry.source.path, `marketplace entry ${plugin}`),
  };
}
