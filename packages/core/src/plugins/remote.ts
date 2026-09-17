/**
 * `seekforge plugin install <source>` beyond a local directory: a git
 * repository, an https archive, or `<plugin>@<marketplace>`.
 *
 * Every path ends in the same place — `installPlugin` on a staged local copy —
 * so the manifest checks, the link/size bounds and the rule that a new or
 * updated plugin starts disabled until its digest is approved apply unchanged.
 * What this adds is provenance: the commit or archive hash the staged copy came
 * from is recorded as the plugin's origin.
 */

import { join } from "node:path";
import { readPluginManifest } from "./load.js";
import { installPlugin, type InstallPluginResult } from "./manage.js";
import { type MarketplaceEntrySource, resolveMarketplacePlugin, withMarketplaceLeaseAsync } from "./marketplace.js";
import {
  type ArchiveFormat,
  archiveContentRoot,
  classifyPluginSource,
  cloneShallow,
  confinedDirectory,
  createStagingDir,
  downloadArchive,
  extractArchive,
  redactSourceUrl,
} from "./source.js";
import type { PluginOrigin } from "./types.js";

export type InstallFromSourceOptions = {
  force?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Base for relative local paths; defaults to the process cwd. */
  cwd?: string;
};

export type InstallFromSourceResult = InstallPluginResult & { origin: PluginOrigin };

type RemoteSource = Exclude<MarketplaceEntrySource, { kind: "relative" }>;
type GitOrigin = Extract<PluginOrigin, { kind: "git" }>;
type ArchiveOrigin = Extract<PluginOrigin, { kind: "archive" }>;

function sniffArchiveFormat(body: Buffer): ArchiveFormat {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) return "tar.gz";
  if (body.length >= 4 && body.readUInt32LE(0) === 0x04034b50) return "zip";
  throw new Error("downloaded file is neither a gzip-compressed tar nor a zip archive");
}

/**
 * Fetch a remote source into a private staging directory. The caller owns the
 * returned `cleanup` and must run it whether or not the install succeeds.
 */
async function stageRemote(
  source: RemoteSource,
  opts: InstallFromSourceOptions,
): Promise<{ dir: string; origin: GitOrigin | ArchiveOrigin; cleanup: () => void }> {
  const staging = createStagingDir("plugins");
  try {
    if (source.kind === "git") {
      const checkout = join(staging.path, "checkout");
      const commit = await cloneShallow(source.url, checkout, {
        ...(source.ref !== undefined ? { ref: source.ref } : {}),
        ...(source.sha !== undefined ? { sha: source.sha } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return {
        dir: confinedDirectory(checkout, source.subdir),
        origin: {
          kind: "git",
          url: redactSourceUrl(source.url),
          ...(source.ref !== undefined ? { ref: source.ref } : {}),
          commit,
          ...(source.subdir !== undefined ? { subdir: source.subdir } : {}),
        },
        cleanup: staging.cleanup,
      };
    }
    const download = await downloadArchive(source.url, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (source.sha256 !== undefined && download.sha256 !== source.sha256) {
      throw new Error(`archive sha256 mismatch: expected ${source.sha256}, got ${download.sha256}`);
    }
    const format = source.format ?? sniffArchiveFormat(download.body);
    const extracted = join(staging.path, "extracted");
    await extractArchive(download.body, format, staging.path, extracted, opts.signal);
    return {
      dir: confinedDirectory(archiveContentRoot(extracted), source.subdir),
      origin: {
        kind: "archive",
        url: redactSourceUrl(source.url),
        sha256: download.sha256,
        ...(source.subdir !== undefined ? { subdir: source.subdir } : {}),
      },
      cleanup: staging.cleanup,
    };
  } catch (error) {
    staging.cleanup();
    throw error;
  }
}

function assertManifestId(dir: string, expected: string): void {
  const manifest = readPluginManifest(dir);
  if (manifest.id !== expected) {
    throw new Error(`marketplace entry ${expected} points at plugin ${manifest.id}; refusing the mismatched install`);
  }
}

async function installFromMarketplace(
  plugin: string,
  marketplace: string,
  opts: InstallFromSourceOptions,
): Promise<InstallFromSourceResult> {
  // Held across the whole install so `marketplace remove`/`add --force` cannot
  // swap the cached checkout out from under the copy.
  return withMarketplaceLeaseAsync(async () => {
    const resolved = resolveMarketplacePlugin(plugin, marketplace);
    const wrap = (source: PluginOrigin): PluginOrigin => ({ kind: "marketplace", marketplace, plugin, source });
    if (resolved.localDir !== undefined) {
      const { record } = resolved;
      const relative = resolved.entry.source.kind === "relative" ? resolved.entry.source.path : undefined;
      const inner: PluginOrigin =
        record.kind === "git"
          ? {
              kind: "git",
              url: record.source,
              ...(record.ref !== undefined ? { ref: record.ref } : {}),
              commit: record.commit ?? "unknown",
              ...(relative !== undefined && relative !== "." ? { subdir: relative } : {}),
            }
          : { kind: "local", path: resolved.localDir };
      assertManifestId(resolved.localDir, plugin);
      const origin = wrap(inner);
      return { ...installPlugin(resolved.localDir, { force: opts.force, origin }), origin };
    }
    const source = resolved.entry.source as RemoteSource;
    const staged = await stageRemote(source, opts);
    try {
      assertManifestId(staged.dir, plugin);
      const origin = wrap(staged.origin);
      return { ...installPlugin(staged.dir, { force: opts.force, origin }), origin };
    } finally {
      staged.cleanup();
    }
  });
}

/**
 * Install (or with `force`, update) a plugin from a local path, git URL
 * (optionally `#ref`), https `.tar.gz`/`.tgz`/`.zip`, or `<plugin>@<marketplace>`.
 * The result is always disabled until `setPluginEnabled` approves its digest.
 */
export async function installPluginFromSource(
  spec: string,
  opts: InstallFromSourceOptions = {},
): Promise<InstallFromSourceResult> {
  const source = classifyPluginSource(spec, opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  switch (source.kind) {
    case "local": {
      const origin: PluginOrigin = { kind: "local", path: source.path };
      return { ...installPlugin(source.path, { force: opts.force, origin }), origin };
    }
    case "marketplace":
      return installFromMarketplace(source.plugin, source.marketplace, opts);
    default: {
      const staged = await stageRemote(
        source.kind === "git"
          ? { kind: "git", url: source.url, ...(source.ref !== undefined ? { ref: source.ref } : {}) }
          : { kind: "archive", url: source.url, format: source.format },
        opts,
      );
      try {
        return { ...installPlugin(staged.dir, { force: opts.force, origin: staged.origin }), origin: staged.origin };
      } finally {
        staged.cleanup();
      }
    }
  }
}

/** Short provenance line for CLI output: the pinned commit or archive hash. */
export function describePluginOrigin(origin: PluginOrigin): string {
  switch (origin.kind) {
    case "local":
      return `local ${origin.path}`;
    case "git":
      return `git ${origin.url}${origin.ref ? `#${origin.ref}` : ""} @ ${origin.commit}${origin.subdir ? ` (${origin.subdir})` : ""}`;
    case "archive":
      return `archive ${origin.url} sha256:${origin.sha256}${origin.subdir ? ` (${origin.subdir})` : ""}`;
    case "marketplace":
      return `${origin.plugin}@${origin.marketplace} via ${describePluginOrigin(origin.source)}`;
  }
}
