// Where the drift gates get their inputs.
//
// The gates in this directory have had three blind spots of one shape: each
// hard-coded *where* to look for a surface, so anything registered in a new
// place was exempt by default and nothing said so. Route scanning listed
// `routes/`; `configKeys()` listed `CliConfig`; `cliCommands()` listed
// `apps/cli/src` and `apps/cli/src/commands` and therefore missed the three
// registrars that sit one directory above `commands/`.
//
// This module exists so no gate has to write such a list again. Two rules:
//
//   1. Discover structurally. A scan root is a recursive walk or a glob-shaped
//      rule ("every apps/<app>/src/config.ts"), never an enumeration.
//   2. Provide a *second, differently derived* view of the same surface, so a
//      registrar the first view cannot see shows up as a mismatch rather than
//      as silence. `cliCommandTree()` asks commander; `sweep()` asks the whole
//      workspace for a registration idiom. Neither is the walk, so neither can
//      inherit the walk's blind spot.

import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative path, for messages a human can act on. */
export const rel = (file) => file.slice(root.length + 1);

const SKIP_DIRS = new Set(["node_modules", "dist", "target", "coverage", ".git", "build", "out"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/** Test, fixture and mock code, which registers nothing a user can reach. */
export const isTestPath = (path) =>
  /(^|[/\\])(tests?|__tests__|__mocks__|mock|fixtures|test-fixtures)[/\\]/.test(path) ||
  /\.(test|spec)\./.test(path) ||
  /[/\\]setup-tests?\./.test(path);

/** Every source file under `dir`, recursively. Build output is skipped. */
export function sourceFilesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) sourceFilesUnder(full, out);
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The workspace packages, read out of `pnpm-workspace.yaml` rather than listed.
 * A fourth app or package is then covered by construction.
 */
export function workspacePackages() {
  const globs = [...readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s*-\s*"([^"]+)"/gm)].map(
    (match) => match[1],
  );
  const packages = [];
  for (const glob of globs) {
    const [parent, leaf] = glob.split("/");
    if (leaf !== "*" || !existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, parent, entry.name);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      packages.push({ name: JSON.parse(readFileSync(manifest, "utf8")).name, dir });
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

let workspaceCache;
/** Every shipped (non-test) source file in every workspace package. */
/**
 * Every tracked source file in the repository, not just the ones under a
 * workspace package's `src/`.
 *
 * This is the "anywhere" in {@link sweep}. It used to be
 * `workspacePackages() → sourceFilesUnder(dir/src)` — the identical expression
 * the i18n walk uses — so that coverage check compared a set against itself and
 * could not fail on a table living anywhere else. `--others` matters for the
 * same reason it does in the reachability gate: a file added in this commit
 * must be swept now, not on the next CI run.
 */
export function workspaceSources() {
  if (!workspaceCache) {
    const tracked = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.ts", "*.tsx", "*.cjs", "*.mjs"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
    workspaceCache = tracked
      .filter((file) => !file.includes("node_modules/") && !file.endsWith(".d.ts"))
      .filter((file) => !isTestPath(file))
      .map((file) => join(root, file));
  }
  return workspaceCache;
}

const contents = new Map();
/** File text, read once per process — the sweeps below cross the same files. */
export function textOf(file) {
  let text = contents.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    contents.set(file, text);
  }
  return text;
}

/**
 * Every workspace file whose text matches a registration idiom.
 *
 * This is the half of each gate that is *not* the walk. A walk answers "what is
 * under this directory"; a sweep answers "who anywhere writes this shape". When
 * a sweep finds a registrar outside the walked root, the walk has a blind spot
 * and the gate says so — which is the check the three past incidents needed and
 * did not have.
 */
export function sweep(pattern) {
  return workspaceSources().filter((file) => pattern.test(textOf(file)));
}

/** `files` that do not live under `dir`, as repo-relative paths. */
export function outside(files, dir) {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return files.filter((file) => !file.startsWith(prefix)).map(rel);
}

// ---------------------------------------------------------------------------
// The CLI's own answer to "what commands exist".
// ---------------------------------------------------------------------------

let treeCache;
/**
 * The command tree commander built, obtained by running the real entry point
 * under `scripts/cli-command-tree.mjs`.
 *
 * This is the independent side of the CLI cross-check. The gate's other side
 * greps sources; if the cross-check also grepped sources it would prove
 * nothing, because a registrar neither grep reads is missing from both sets.
 * Commander's registry, by contrast, contains every command the program has —
 * including the ones no regex can see, such as the `schedule install` /
 * `uninstall` / `status` trio that `index.ts` registers from a loop variable.
 */
/** An empty HOME for the probe, so it cannot read the developer's global config. */
function probeHome() {
  if (!probeHomeCache) probeHomeCache = mkdtempSync(join(tmpdir(), "seekforge-cli-probe-"));
  return probeHomeCache;
}
let probeHomeCache;

export function cliCommandTree() {
  if (treeCache) return treeCache;
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  // Reported as a failed probe, never as a skipped check: a gate that quietly
  // stops introspecting is the failure mode this whole file exists to remove.
  if (!existsSync(tsx)) {
    treeCache = Promise.reject(new Error(`cannot introspect the CLI: ${rel(tsx)} is missing — run pnpm install`));
    return treeCache;
  }
  // Transpiling the CLI's whole import graph costs more than every other check
  // in both gates put together, so the probe is started when this function is
  // first called — at module scope, before any test runs — and awaited later.
  // The rest of the file's work happens while it boots.
  treeCache = execFile(process.execPath, [tsx, join(root, "scripts", "cli-command-tree.mjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // No TTY, so the entry point's update notifier stays off and nothing
    // reaches the network. HOME points at an empty directory because the entry
    // point calls `loadConfig(cwd)`, which reads `~/.seekforge/config.json`:
    // inheriting it would make the gate's input depend on the developer's
    // machine (boundary-checklist #420) and let a personal global config
    // change what CI believes the CLI surface is. `SEEKFORGE_LANG` is the
    // variable the CLI actually reads — `SEEKFORGE_LOCALE`, set here before,
    // was read by nothing.
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
      SEEKFORGE_LANG: "en",
      HOME: probeHome(),
      USERPROFILE: probeHome(),
    },
  }).then(({ stdout }) => {
    const marker = stdout.lastIndexOf("__CLI_COMMAND_TREE__");
    if (marker < 0) throw new Error("the CLI command-tree probe produced no tree");
    return JSON.parse(stdout.slice(marker + "__CLI_COMMAND_TREE__".length).trim());
  });
  return treeCache;
}
