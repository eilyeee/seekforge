#!/usr/bin/env node
// SeekForge release helper — bump versions across the monorepo, sanity-check
// the CHANGELOG, and print (or, with --commit, perform) the commit+tag steps.
// No dependencies; pure Node. Never pushes — the user reviews and pushes.
//
// Usage:
//   node scripts/release.mjs <version>            prepare a release (prints next steps)
//   node scripts/release.mjs <version> --commit   also `git commit` + `git tag` (no push)
//   node scripts/release.mjs --check              report version coherence, fail if files disagree

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that must carry the release version, with how to read/write each. */
const TARGETS = [
  { path: "apps/cli/package.json", kind: "json" },
  { path: "apps/tui/package.json", kind: "json" },
  { path: "apps/desktop/package.json", kind: "json" },
  { path: "apps/desktop/src-tauri/tauri.conf.json", kind: "json" },
  { path: "apps/desktop/src-tauri/Cargo.toml", kind: "cargo" },
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

function abs(rel) {
  return join(ROOT, rel);
}

// --- per-kind version read/write -------------------------------------------

/** Read the current version from a target; returns null if the file lacks one. */
function readVersion(target) {
  const text = readFileSync(abs(target.path), "utf8");
  if (target.kind === "json") {
    return JSON.parse(text).version ?? null;
  }
  // cargo: only the [package] version, and only if it's a literal (not inherited).
  return readCargoPackageVersion(text);
}

/** Returns the literal `[package] version = "x"` value, or null if inherited/absent. */
function readCargoPackageVersion(text) {
  const lines = text.split("\n");
  let inPackage = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const m = line.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
    if (m) return m[1];
    // version.workspace = true (or anything non-literal) → inherited, skip.
    if (/^\s*version\s*\.\s*workspace\s*=/.test(line)) return null;
  }
  return null;
}

/** Write the version into a target, preserving formatting as much as possible. */
function writeVersion(target, version) {
  const file = abs(target.path);
  const text = readFileSync(file, "utf8");
  if (target.kind === "json") {
    // Minimal-diff rewrite: replace only the top-level "version" string.
    // Guard on the pattern MATCHING, not on the text changing — a file
    // already at the target version is a valid no-op, not a missing field.
    const re = /("version"\s*:\s*)"[^"]*"/;
    if (!re.test(text)) fail(`could not find a "version" field in ${target.path}`);
    const replaced = text.replace(re, `$1"${version}"`);
    if (replaced !== text) writeFileSync(file, replaced);
    return;
  }
  // cargo: replace the [package] version line only.
  const out = [];
  let inPackage = false;
  let done = false;
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) inPackage = section[1].trim() === "package";
    if (inPackage && !done) {
      const m = line.match(/^(\s*version\s*=\s*)"[^"]*"(\s*)$/);
      if (m) {
        out.push(`${m[1]}"${version}"${m[2]}`);
        done = true;
        continue;
      }
    }
    out.push(line);
  }
  if (!done) fail(`could not find a [package] version line in ${target.path}`);
  writeFileSync(file, out.join("\n"));
}

// --- CHANGELOG check --------------------------------------------------------

/** Returns the first "## <version>" heading's version, or null. */
function topChangelogVersion() {
  let text;
  try {
    text = readFileSync(abs("CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    if (m) return m[1];
  }
  return null;
}

// --- git --------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function assertCleanTree() {
  const status = git(["status", "--porcelain"]).trim();
  if (status) {
    fail(`working tree is dirty — commit or stash first:\n${status}`);
  }
}

// --- modes ------------------------------------------------------------------

/** --check: report coherence; exit 1 if the version-bearing files disagree. */
function runCheck() {
  const found = [];
  for (const target of TARGETS) {
    const v = readVersion(target);
    if (v === null) {
      process.stdout.write(`  ${target.path}: (no literal version — skipped)\n`);
      continue;
    }
    found.push({ path: target.path, version: v });
    process.stdout.write(`  ${target.path}: ${v}\n`);
  }
  const versions = new Set(found.map((f) => f.version));
  if (versions.size <= 1) {
    process.stdout.write(
      `release: coherent — all ${found.length} versioned files at ${[...versions][0] ?? "(none)"}\n`,
    );
    return;
  }
  process.stderr.write(`release: INCOHERENT — files disagree: ${[...versions].join(", ")}\n`);
  process.exit(1);
}

function runBump(version, { commit }) {
  if (!SEMVER_RE.test(version)) fail(`"${version}" is not a valid semver (e.g. 0.8.0)`);
  assertCleanTree();

  for (const target of TARGETS) {
    const current = readVersion(target);
    if (current === null) {
      process.stdout.write(`  ${target.path}: skipped (version is workspace-inherited or absent)\n`);
      continue;
    }
    writeVersion(target, version);
    process.stdout.write(`  ${target.path}: ${current} → ${version}\n`);
  }

  // Root package.json intentionally stays at 0.0.0 (private monorepo root).
  const rootVersion = JSON.parse(readFileSync(abs("package.json"), "utf8")).version;
  if (rootVersion !== "0.0.0") {
    process.stderr.write(`release: warning — root package.json version is ${rootVersion}, expected 0.0.0\n`);
  }

  const changelogTop = topChangelogVersion();
  if (changelogTop !== version) {
    process.stderr.write(
      `release: warning — CHANGELOG.md top section is "## ${changelogTop ?? "(none)"}", not "## ${version}". ` +
        `Add release notes before tagging (not auto-written).\n`,
    );
  } else {
    process.stdout.write(`  CHANGELOG.md: top section matches ${version} ✓\n`);
  }

  const tag = `v${version}`;
  if (commit) {
    git(["commit", "-am", `release: ${tag}`]);
    git(["tag", tag]);
    process.stdout.write(`\nCommitted and tagged ${tag} (not pushed). Review, then:\n`);
    process.stdout.write(`  git push && git push --tags\n`);
  } else {
    process.stdout.write(`\nNext steps (review, then run):\n`);
    process.stdout.write(`  git commit -am "release: ${tag}" && git tag ${tag} && git push && git push --tags\n`);
  }
}

// --- entry ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const positionals = args.filter((a) => !a.startsWith("--"));

  if (args.includes("--check")) {
    runCheck();
    return;
  }
  const version = positionals[0];
  if (!version) {
    fail("usage: node scripts/release.mjs <version> [--commit]  |  node scripts/release.mjs --check");
  }
  runBump(version, { commit });
}

main();
