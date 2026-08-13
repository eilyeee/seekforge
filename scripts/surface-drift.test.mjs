// Drift checks across the surfaces that must agree but are edited separately:
// CLI commands, config keys, REST routes, the two documentation languages, and
// the i18n tables.
//
// Every capability in this repository is wired through Core, then a CLI
// command, a REST route, a Desktop view, and two languages of documentation.
// Nothing mechanical connected those, so a capability could ship with a command
// nobody documented or a translation nobody added — which has happened before.
// These tests fail the build instead of leaving the gap for a later audit.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cliCommandTree,
  isTestPath,
  outside,
  rel,
  root,
  sourceFilesUnder,
  sweep,
  textOf,
  trackedSourceFiles,
  workspacePackages,
} from "./surface-registry.mjs";

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const CLI_SRC = join(root, "apps", "cli", "src");

// Started here, at module scope, so the CLI boots in a child process while the
// file-reading checks below run. Awaited, never blocked on synchronously.
const commandTree = cliCommandTree();

/**
 * Top-level CLI commands, grepped out of every file under `apps/cli/src`.
 *
 * The walk is recursive on purpose. It used to be two hard-coded directories,
 * and `register-graph.ts`, `register-loop.ts` and `register-orchestration.ts`
 * sit one level above `commands/`, so `graph`, `orchestration`, `loop` and the
 * 22 flat `loop-*` commands were exempt from a check whose name promises every
 * top-level command. A recursive walk cannot have that defect again; the two
 * cross-checks below cover the parts a walk still cannot reach.
 */
function scannedCliCommands() {
  const names = new Set();
  for (const file of sourceFilesUnder(CLI_SRC)) {
    if (isTestPath(rel(file))) continue;
    for (const match of textOf(file).matchAll(/program\s*\n?\s*\.command\(\s*"([a-z][a-z0-9-]*)"/g))
      names.add(match[1]);
  }
  return names;
}

/**
 * User-facing documentation for one language. Subcommands are documented
 * wherever their capability lives — the README summary table, the CLI
 * reference, or a topic guide — so the corpus is every page of that language.
 */
function docCorpus(chinese) {
  const parts = [read(chinese ? "README.zh-CN.md" : "README.md")];
  for (const name of readdirSync(join(root, "docs"))) {
    if (name.endsWith(".md") && name.endsWith(".zh-CN.md") === chinese) parts.push(read("docs", name));
  }
  // Inline spans and fenced example lines both count; fences are tracked per
  // file so an unbalanced one cannot swallow the rest of the corpus.
  return parts.flatMap((source) => {
    const spans = [...source.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
    let fenced = false;
    for (const line of source.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      else if (fenced) spans.push(line.trim());
    }
    return spans;
  });
}

/**
 * Config keys every surface declares, found by locating each frontend's config
 * module instead of naming three of them.
 *
 * The rule is "the `<Name>Config` type exported by `<package>/src/config.ts`",
 * applied to every workspace package. It used to be a list, which read
 * `CliConfig` alone — so `runRetentionMaxCount`, `accent`, `bell`, `vim` and
 * friends were live, effective, and documented nowhere. A list would have been
 * just as blind to a fourth frontend's config module; the rule is not.
 *
 * Returns `{keys, modules}` so the self-check below can report where it looked.
 */
function declaredConfigKeys() {
  const keys = new Set();
  const modules = [];
  for (const pkg of workspacePackages()) {
    const file = join(pkg.dir, "src", "config.ts");
    if (!existsSync(file)) continue;
    const source = textOf(file);
    let found = false;
    for (const match of source.matchAll(/^export type ([A-Za-z][A-Za-z0-9]*Config) = \{$/gm)) {
      const body = source.slice(match.index + match[0].length);
      const end = body.indexOf("\n};");
      assert.ok(end > 0, `${rel(file)}: could not find the end of ${match[1]}`);
      for (const key of body.slice(0, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) keys.add(key[1]);
      found = true;
    }
    if (found) modules.push(rel(file));
  }
  return { keys, modules };
}

/**
 * The manifest in `packages/shared/src/config-manifest.ts` is what the running
 * program uses to decide whether a key in someone's config.json is real or a
 * typo. It is maintained by hand, next to the types but not derived from them,
 * which makes it the independent second view this gate needs: the type
 * declarations say what a surface accepts, the manifest says what the surfaces
 * admit to accepting, and the two can disagree in both directions.
 */
function manifestConfigKeys() {
  const source = read("packages", "shared", "src", "config-manifest.ts");
  const block = (marker) => {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `packages/shared/src/config-manifest.ts no longer declares ${marker}`);
    // The two declarations close differently (`] as const` for the flat array,
    // `} as const` for the per-surface object), so take whichever comes first.
    const body = source.slice(at);
    const end = /[\]}] as const/.exec(body)?.index ?? -1;
    assert.ok(end > 0, `packages/shared/src/config-manifest.ts: could not find the end of ${marker}`);
    return body.slice(0, end);
  };
  const keys = new Set();
  for (const match of block("COMMON_CONFIG_KEYS").matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/g)) keys.add(match[1]);
  for (const match of block("SURFACE_CONFIG_KEYS").matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/g)) keys.add(match[1]);
  return keys;
}

/**
 * The self-check for the config surface. A key that reaches only one of these
 * two sets is a live defect either way: in the types but not the manifest means
 * every frontend calls it a typo, in the manifest but no type means the program
 * accepts a key nothing declares — and either way the documentation check below
 * would have been running on an incomplete set without noticing.
 */
test("the config keys this gate scans are the config keys the program honors", () => {
  const { keys, modules } = declaredConfigKeys();
  assert.ok(modules.length >= 3, `expected every frontend to declare a config module, found ${modules.join(", ")}`);
  const manifest = manifestConfigKeys();
  assert.deepEqual(
    [...keys].filter((key) => !manifest.has(key)).sort(),
    [],
    `declared in ${modules.join(", ")} but absent from packages/shared/src/config-manifest.ts — ` +
      "every frontend would reject these keys as typos",
  );
  assert.deepEqual(
    [...manifest].filter((key) => !keys.has(key)).sort(),
    [],
    `listed in packages/shared/src/config-manifest.ts but declared by no <Name>Config type in ${modules.join(", ")} — ` +
      "either a frontend's config module is somewhere this gate does not look, or the key is honored by nothing",
  );
});

test("every config key is documented in both configuration guides", () => {
  const { keys } = declaredConfigKeys();
  assert.ok(keys.size > 10, `expected many config keys, found ${keys.size}`);
  for (const [file, label] of [
    ["docs/configuration.md", "English configuration guide"],
    ["docs/configuration.zh-CN.md", "Chinese configuration guide"],
  ]) {
    const source = read(file);
    const missing = [...keys].filter((key) => !source.includes(`\`${key}\``));
    assert.deepEqual(missing, [], `${label} never mentions these config keys — an undocumented key is an unusable one`);
  }
});

test("the version SeekForge announces on the MCP wire is the released one", () => {
  const cliVersion = JSON.parse(read("apps", "cli", "package.json")).version;
  const core = read("packages", "core", "src", "version.ts");
  const declared = /export const SEEKFORGE_VERSION = "([^"]*)";/.exec(core)?.[1];
  assert.equal(declared, cliVersion, "packages/core/src/version.ts disagrees with the published CLI version");
  for (const file of ["client.ts", "http.ts", "server.ts"]) {
    const source = read("packages", "core", "src", "mcp", file);
    assert.ok(
      !/version: "\d+\.\d+\.\d+"/.test(source),
      `mcp/${file} hard-codes a version literal; use SEEKFORGE_VERSION so releases bump it`,
    );
  }
});

const SERVER_SRC = join(root, "apps", "server", "src");

/**
 * The three shapes a route is registered in. Kept in one place because the
 * self-check below sweeps the workspace with the same patterns the scan uses:
 * that is what makes "a registrar somewhere unscanned" detectable rather than
 * silently exempt.
 */
const ROUTE_IDIOMS = [
  /\.(?:get|post|put|patch|delete)\(\s*"\/api\//,
  /path === "\/api\//,
  /segs\[1\]\s*(?:===|!==)\s*"/,
];

/** Every server source file, recursively — not just the ones under routes/. */
function routeSources() {
  return sourceFilesUnder(SERVER_SRC).filter((file) => !isTestPath(rel(file)));
}

/**
 * The self-check for the REST surface.
 *
 * The scan used to read `apps/server/src/routes/` and nothing else, which was
 * fine right up to the moment a route was registered a directory away:
 * `rest.ts` itself owns `/api/health`, `/api/ready`, `/api/metrics` and
 * `/api/models`, and all four were exempt from a check whose name promises
 * "every REST route path". The scan is now the whole of `apps/server/src`, and
 * this test is the part that notices when that root stops being enough — a
 * route group extracted into `packages/` fails here instead of quietly
 * dropping out of the documentation gate.
 */
test("the REST surface this gate scans is the whole REST surface", () => {
  const registrars = sweep(new RegExp(ROUTE_IDIOMS.map((idiom) => idiom.source).join("|")));
  assert.ok(registrars.length > 10, `expected many route modules, found ${registrars.length}`);
  assert.deepEqual(
    outside(registrars, SERVER_SRC),
    [],
    "these files register REST routes but sit outside apps/server/src, so the route scan never reads them — " +
      "every route they own is exempt from the SERVER-API.md check until this root is widened",
  );
});

test("every REST route path is described in SERVER-API.md", () => {
  const documented = read("apps", "server", "SERVER-API.md");
  const missing = [];
  for (const file of routeSources()) {
    const name = rel(file).slice(rel(SERVER_SRC).length + 1);
    const source = textOf(file);
    // Two registration styles exist, and this check used to see only the first:
    // a router call (`.post("/api/x")`) and a hand-rolled dispatch
    // (`method === "POST" && path === "/api/x"`). Every route in memory.ts,
    // files.ts, git.ts, security.ts, sessions.ts and settings.ts is written the
    // second way, so 48 routes were exempt from a check whose name promises
    // "every REST route" — and 8 of them were in fact undocumented.
    const routes = [
      ...[...source.matchAll(/\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g)].map((m) => ({
        method: m[1].toUpperCase(),
        path: m[2],
      })),
      ...[...source.matchAll(/path === "(\/api\/[^"]*)"/g)].map((m) => ({ method: "", path: m[1] })),
    ];
    // A third style appeared after the two above and was again invisible here:
    // segment dispatch (`segs[3] === "control"`). Every route in graphs.ts,
    // loops.ts, orchestration.ts and sessions.ts is written that way, so the
    // check named "every REST route" was once more exempting most of them.
    // Literals are scoped to the nearest preceding `segs[1]` guard because a
    // file can own several bases (skills-agents.ts owns four).
    const guards = [...source.matchAll(/segs\[1\]\s*(?:===|!==)\s*"([a-z0-9-]+)"/g)];
    const baseAt = (index) => {
      let base;
      for (const guard of guards) {
        if (guard.index < index) base = guard[1];
        else break;
      }
      return base ?? guards[0]?.[1];
    };
    const segmented = new Set();
    for (const match of source.matchAll(/segs\[([2-9])\]\s*===\s*"([a-z0-9-]+)"/g)) {
      if (guards.length > 0) segmented.add(`${baseAt(match.index)} ${match[2]}`);
    }
    for (const match of source.matchAll(/\[([^\]]*)\]\.includes\(\s*segs\[[2-9]\]/g)) {
      for (const literal of match[1].matchAll(/"([a-z0-9-]+)"/g)) {
        if (guards.length > 0) segmented.add(`${baseAt(match.index)} ${literal[1]}`);
      }
    }
    const documentedLines = documented.split("\n");
    for (const entry of segmented) {
      const [base, segment] = entry.split(" ");
      // Do not reconstruct the full path: `/api/graphs/templates/:id/:version/
      // deprecate` nests deeper than its dispatch index suggests. Require only
      // that some documented route under this base carries this segment, and
      // accept the `accept\|reject\|apply` alternation this file writes routes
      // in — there the segment follows a pipe rather than a slash.
      const carries = new RegExp(`[/|]${segment}(?![A-Za-z0-9-])`);
      const covered = documentedLines.some((line, index) => {
        if (!carries.test(line)) return false;
        if (line.includes(`/api/${base}`)) return true;
        // Long bullets continue a route as `.../:id/apply` once the base is
        // established, so look back a few lines for it rather than demanding
        // the base be repeated on every line.
        return (
          line.includes(".../") &&
          documentedLines.slice(Math.max(0, index - 6), index).some((prior) => prior.includes(`/api/${base}`))
        );
      });
      if (!covered) missing.push(`${name}: /api/${base} … /${segment}`);
    }
    for (const route of routes) {
      // Path parameters are named freely in docs (:id vs :sessionId), so compare
      // on the static prefix before the first parameter.
      const prefix = route.path.split("/:")[0];
      if (!documented.includes(prefix)) missing.push(`${name}: ${route.method} ${route.path}`.trim());
    }
  }
  assert.deepEqual(missing, [], "REST routes missing from apps/server/SERVER-API.md");
});

test("every English doc has a Chinese counterpart, and vice versa", () => {
  const docs = readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md"));
  const english = docs.filter((name) => !name.endsWith(".zh-CN.md"));
  const chinese = new Set(docs.filter((name) => name.endsWith(".zh-CN.md")));
  const missingChinese = english.filter((name) => !chinese.has(name.replace(/\.md$/, ".zh-CN.md")));
  const orphanChinese = [...chinese].filter((name) => !english.includes(name.replace(/\.zh-CN\.md$/, ".md")));
  assert.deepEqual(missingChinese, [], "English docs without a zh-CN counterpart");
  assert.deepEqual(orphanChinese, [], "zh-CN docs whose English original is gone");
});

test("bilingual docs cross-link each other", () => {
  for (const name of readdirSync(join(root, "docs"))) {
    if (!name.endsWith(".md") || name.endsWith(".zh-CN.md")) continue;
    const english = read("docs", name);
    const chinese = read("docs", name.replace(/\.md$/, ".zh-CN.md"));
    assert.ok(english.includes(name.replace(/\.md$/, ".zh-CN.md")), `docs/${name} does not link its translation`);
    assert.ok(chinese.includes(`(${name})`), `docs/${name.replace(/\.md$/, ".zh-CN.md")} does not link the original`);
  }
});

/**
 * A locale tag written as an identifier: `en`, `"zh-CN"`, `EN`, `ZH_CN`.
 * Returns the canonical tag, or undefined when the name is not one.
 *
 * This replaces the two hand-written locale lists the readers used to carry.
 * It is a rule, so `FR` / `ja` / `"pt-BR"` are recognized the day they appear
 * rather than the day someone remembers to extend a list.
 */
function localeTag(name) {
  const normalized = name.replaceAll('"', "").replaceAll("_", "-").toLowerCase();
  const match = /^([a-z]{2})(?:-([a-z]{2}))?$/.exec(normalized);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2].toUpperCase()}` : match[1];
}

/**
 * The locale tables a module declares, in either shape the repo uses: nested
 * properties (`en: { … }`, the CLI and Desktop) or sibling top-level consts
 * (`const EN = { … }`, the TUI). One reader for both, because "which shape does
 * this surface use" was itself a per-surface constant this gate had to know.
 *
 * Keys sit exactly one indent level inside the table opener, and the table ends
 * at the first brace back at the opener's own indent — which is how a nested
 * value object inside an entry does not leak its own keys into the set.
 */
function localeTables(source) {
  const tables = {};
  const openers = [
    ...source.matchAll(
      /^( *)(?:(en|zh|"[a-zA-Z-]+"|[a-z]{2}(?:-[A-Z]{2})?):|const ([A-Za-z][A-Za-z0-9_]*)\s*(?::[^=\n]*)?=)\s*\{$/gm,
    ),
  ];
  for (const opener of openers) {
    const indent = opener[1];
    const locale = localeTag(opener[2] ?? opener[3] ?? "");
    if (!locale) continue;
    const body = source.slice(opener.index + opener[0].length);
    const end = body.indexOf(`\n${indent}}`);
    if (end < 0) continue;
    const keys = new Set(
      [...body.slice(0, end).matchAll(new RegExp(`^${indent} {2}"([^"]+)":`, "gm"))].map((entry) => entry[1]),
    );
    // Two consts named `EN` and `ZH_CN` in one file are one table pair; two
    // objects both keyed `en` would be a merge, which is what the CLI's
    // multi-section modules do.
    tables[locale] = new Set([...(tables[locale] ?? []), ...keys]);
  }
  return tables;
}

/**
 * Is this module a locale table? It must carry an English table and at least
 * one translation of it.
 *
 * Requiring `en` is what separates a translation from a lookup table that
 * happens to be keyed by two-letter names: `apps/desktop/src/lib/highlight.ts`
 * declares `ts`, `py`, `rs`, `go` and `sh`, all of them valid language
 * subtags, and none of them a locale this program renders in.
 */
const isLocaleTableModule = (file) => {
  const tables = localeTables(textOf(file));
  return Object.keys(tables).length > 1 && (tables.en?.size ?? 0) > 0;
};

/**
 * Every localized surface, discovered rather than listed.
 *
 * A surface is a workspace package that owns at least one locale-table module;
 * its tables are those modules and its corpus is the rest of the package. The
 * old version named three surfaces and seven files, and the seven were only
 * correct because someone kept them correct: the CLI and Desktop keep tables
 * under `i18n/`, the TUI keeps its in `strings.ts` among ordinary modules, so
 * no path convention covered them and the list was the convention.
 */
function i18nSurfaces() {
  const surfaces = new Map();
  for (const pkg of workspacePackages()) {
    const src = join(pkg.dir, "src");
    const tables = sourceFilesUnder(src)
      .filter((file) => !isTestPath(rel(file)))
      .filter(isLocaleTableModule);
    if (tables.length > 0) surfaces.set(rel(pkg.dir), { src, tables });
  }
  return surfaces;
}

test("every localized surface's tables are the tables this gate reads", () => {
  const surfaces = i18nSurfaces();
  const found = [...surfaces.values()].flatMap((surface) => surface.tables);
  assert.ok(surfaces.size >= 3, `expected the CLI, TUI and Desktop to be localized, found ${surfaces.size} surfaces`);
  // Independent of the walk above: a file that mentions a Chinese table at all
  // is a translation, and if it is not one of the modules discovered as a
  // locale table then the reader stopped understanding its shape — at which
  // point the parity and dead-key checks below silently cover less than they
  // claim, which is precisely how the TUI's dead-key check became a no-op.
  const translated = sweep(/^\s*(?:"zh-CN"|zh):\s*\{$|^const ZH[_A-Z]*\s*(?::[^=\n]*)?=\s*\{$/m);
  assert.deepEqual(
    translated.filter((file) => !found.includes(file)).map(rel),
    [],
    "these modules hold a Chinese translation table that the locale-table reader does not recognize — " +
      "their keys are checked for neither parity nor use",
  );
});

test("i18n tables define the same keys in every locale", () => {
  for (const [name, surface] of i18nSurfaces()) {
    for (const file of surface.tables) {
      const tables = localeTables(textOf(file));
      const locales = Object.keys(tables);
      assert.ok(locales.includes("en"), `${rel(file)} has no English table`);
      assert.ok(locales.length > 1, `${rel(file)} has no translation table`);
      for (const locale of locales) {
        if (locale === "en") continue;
        const missing = [...tables.en].filter((key) => !tables[locale].has(key));
        const extra = [...tables[locale]].filter((key) => !tables.en.has(key));
        assert.deepEqual(missing, [], `${name}/${rel(file)}: ${locale} is missing keys`);
        assert.deepEqual(extra, [], `${name}/${rel(file)}: ${locale} has keys English does not`);
      }
    }
  }
});

/**
 * Key prefixes a surface builds at runtime, read out of the source rather than
 * listed by hand.
 *
 * `t(`tips.${i}`)` means every `tips.N` is live even though none appears as a
 * literal. Writing those prefixes down by hand would be one more list that
 * drifts — and a stale one turns this gate into a false-positive generator,
 * which is worse than no gate. So: find the template calls, take the literal
 * head of each. (Confirmed the hard way — a hand-run of this check reported 21
 * dead keys in the TUI, all of them `tips.`/`hints.`, and the real number is 0.)
 */
function dynamicKeyPrefixes(source) {
  const prefixes = new Set();
  for (const match of source.matchAll(/\bt(?:ranslate)?\(\s*`([^`$]*)\$\{/g)) {
    if (match[1]) prefixes.add(match[1]);
  }
  return [...prefixes];
}

test("every i18n key is actually used somewhere", () => {
  // The parity test above proves both languages define the same keys. It says
  // nothing about whether anyone reads them, and 30 of the CLI's 299 turned out
  // to be dead: 13 because the doctor checks moved into @seekforge/shared and
  // their translations did not follow — so `seekforge doctor` printed English
  // details under a Chinese header — and 17 left behind by a namespace rename,
  // still translated in both languages, superseded by keys under a newer prefix.
  //
  // Both failure modes are invisible: a dead key is not an error, it is a
  // translation nobody sees, and the English fallback looks like a missing
  // translation rather than a wiring bug.
  //
  // The corpus a key is looked for in is the surface's own sources *minus* the
  // table modules, and the table modules are the ones discovered above rather
  // than a directory convention. The convention only ever held for two of the
  // three surfaces — the TUI keeps its table in `strings.ts` among ordinary
  // modules — so skipping by directory name left the TUI's table inside the
  // corpus, every key matched its own definition line, and the check reported
  // zero because it could report nothing else.
  for (const [name, surface] of i18nSurfaces()) {
    const keys = new Set();
    for (const file of surface.tables) {
      for (const key of localeTables(textOf(file)).en ?? []) keys.add(key);
    }
    const tableFiles = new Set(surface.tables);
    const source = sourceFilesUnder(surface.src)
      .filter((file) => !tableFiles.has(file))
      .map((file) => textOf(file))
      .join("\n");
    const dynamic = dynamicKeyPrefixes(source);
    const unused = [...keys]
      .filter((key) => !source.includes(`"${key}"`) && !dynamic.some((prefix) => key.startsWith(prefix)))
      .sort();
    assert.deepEqual(unused, [], `${name}: i18n keys defined in both languages but read by nobody`);
  }
});

// ---------------------------------------------------------------------------
// The CLI surface. Declared last on purpose: everything above reads files, the
// checks below wait on a child process that boots the real CLI, and node:test
// runs the tests in a file one at a time. Putting the slow one first made the
// whole file wait for it; putting it last means it boots while the rest runs.
// ---------------------------------------------------------------------------

/**
 * The self-check the three past blind spots needed: is the set of files this
 * gate scanned the complete set of files that could register a CLI command?
 *
 * Two independent answers, neither of them the walk:
 *
 *   - A workspace-wide sweep for the commander import. A registrar cannot take
 *     a `Command` without naming the package, so `register-plugin-v2.ts` in a
 *     directory — or a package — nobody thought to scan is found here and
 *     reported, instead of being silently exempt.
 *   - Commander's own registry, via `scripts/cli-command-tree.mjs`. Every name
 *     the grep found must be a name the built program has; when it is not, the
 *     entry point stopped wiring a registrar the sources still write, and the
 *     command is dead rather than undocumented.
 *
 * The comparison is deliberately not symmetric-by-construction: the two sides
 * are produced by different machinery (a regex over text, and a real commander
 * tree), so a surface invisible to one is still visible to the other. A
 * cross-check that derived both sides the same way would pass forever.
 */
test("the CLI surface this gate scans is the whole CLI surface", async () => {
  const stray = outside(sweep(/from ["']commander["']/), CLI_SRC);
  assert.deepEqual(
    stray,
    [],
    "these files take a commander Command but sit outside apps/cli/src, so the command scan never reads them — " +
      "move them under apps/cli/src or widen CLI_SRC; leaving them here exempts every command they register",
  );

  const tree = await commandTree;
  const registered = new Set(tree.commands);
  const scanned = scannedCliCommands();

  // Both directions, because they catch opposite defects and only one of them
  // is about coverage. `scanned \ registered` finds a dead command; the check
  // this test is NAMED for is `registered \ scanned` — a command the running
  // program has that the source walk cannot see. The two sets happen to be
  // equal today, so asserting only the first passed either way.
  const unscanned = [...registered].filter((name) => !scanned.has(name)).sort();
  assert.deepEqual(
    unscanned,
    [],
    "commander builds these top-level commands but the source scan cannot see them, so anything it derives " +
      "from the scan silently excludes them — find where they are registered and widen the scan to reach it",
  );

  const invisible = [...scanned].filter((name) => !registered.has(name)).sort();
  assert.deepEqual(
    invisible,
    [],
    "the sources register these top-level commands but the program commander builds does not have them — " +
      "either the entry point no longer imports their registrar (the command is dead) or the probe cannot see it",
  );
  assert.ok(
    tree.commands.length >= 50,
    `commander reports only ${tree.commands.length} top-level commands; the probe is not seeing the real program`,
  );
});

test("every top-level CLI command appears in both README command tables", async () => {
  // Commander's tree, not the grep: it is the only source that has the names
  // no literal spells out. `index.ts` registers `schedule install`,
  // `uninstall` and `status` from a loop over an array, and the aliases
  // `plugins` and `upgrade` through `.alias()`; every one of them was exempt
  // from this check while it read source text.
  const commands = new Set((await commandTree).commands);
  assert.ok(commands.size > 10, `expected the CLI to register many commands, found ${commands.size}`);
  for (const [file, label] of [
    ["README.md", "English README"],
    ["README.zh-CN.md", "Chinese README"],
  ]) {
    const source = read(file);
    for (const command of commands) {
      assert.ok(
        // `[^a-z-]`, not `\b`: a word boundary matches at a hyphen, so a row
        // for `seekforge loop-prune` satisfied a required row for `prune`.
        // Nine names alias that way today. The subcommand check below already
        // uses this form.
        new RegExp(`\`seekforge [^\`]*(?<![a-z-])${command}(?![a-z-])`).test(source),
        `${label} has no row for \`seekforge ${command}\` — document it or the command is undiscoverable`,
      );
    }
  }
});

/**
 * The check above greps raw Markdown, so it stays green even when the rows it
 * finds render as literal pipe-text. A blank line ends a GFM table: a paragraph
 * spliced into the middle of the command table silently demotes every row below
 * it, which is how a VS Code note left 14 commands — `security`, `mcp`, `skill`,
 * `plugin`, `memory`, `config` among them — rendering as raw text on GitHub and
 * npm while this gate reported no drift.
 */
test("each README command table is one uninterrupted table", () => {
  for (const [file, label] of [
    ["README.md", "English README"],
    ["README.zh-CN.md", "Chinese README"],
  ]) {
    const lines = read(file).split("\n");
    let first = lines.findIndex((line) => line.startsWith("| `seekforge"));
    assert.ok(first > 0, `${label} has no command table`);
    // Walk back over the header and delimiter rows: a paragraph spliced above
    // the first command row breaks the table just as completely as one below.
    while (first > 0 && lines[first - 1].startsWith("|")) first -= 1;
    let last = first;
    for (let i = first; i < lines.length; i += 1) if (lines[i].startsWith("| `seekforge")) last = i;
    for (let i = first; i <= last; i += 1) {
      assert.ok(
        lines[i].startsWith("|"),
        `${label} line ${i + 1} interrupts the command table — ` +
          `every row after it renders as literal text, not a table:\n  ${lines[i]}`,
      );
    }
  }
});

/**
 * Every `<group> <sub>` pair the CLI registers, e.g. `graph signal` or
 * `graph template list`. The top-level check above only sees `graph`, so a
 * whole subcommand could ship undocumented behind an already-documented group
 * — which is exactly how `graph signal`, `graph evidence` and the template
 * registry stayed CLI-invisible while REST had them.
 */
async function cliSubcommands() {
  // Read off commander's tree rather than reconstructed from text. The text
  // version tracked `const graph = program.command("graph")` assignments
  // within a single file, so it could not follow a group created in one module
  // and extended in another, and it could not see a name that is not a
  // literal: `schedule install`, `schedule uninstall` and `schedule status`
  // come out of `for (const action of [...]) schedule.command(action)` and
  // were invisible to this check for as long as it existed.
  const tree = await commandTree;
  return new Map(Object.entries(tree.subcommands).map(([group, names]) => [group, new Set(names)]));
}

test("every CLI subcommand appears in both languages of documentation", async () => {
  const groups = await cliSubcommands();
  assert.ok(groups.size > 5, `expected several CLI command groups, found ${groups.size}`);
  for (const [chinese, label] of [
    [false, "English documentation"],
    [true, "Chinese documentation"],
  ]) {
    // Only code spans introducing this group can satisfy it, so prose that
    // merely happens to contain the word does not count as documentation.
    const spans = docCorpus(chinese);
    const missing = [];
    for (const [group, subcommands] of groups) {
      const scoped = spans.filter((span) => span.startsWith(`${group} `) || span.startsWith(`seekforge ${group} `));
      const documented = scoped.join("\n");
      for (const sub of subcommands) {
        if (!new RegExp(`(^|[^a-z-])${sub}([^a-z-]|$)`).test(documented)) missing.push(`${group} ${sub}`);
      }
    }
    // Report the whole drift set at once; fixing them one build at a time is
    // how a surface stays undocumented for another dozen commits.
    assert.deepEqual(
      missing,
      [],
      `${label} never documents these subcommands — an undocumented subcommand is an undiscoverable one`,
    );
  }
});

/**
 * Every `--flag` a command declares, grepped out of `apps/cli/src` — the text
 * side of the options cross-check below, deliberately built the same way
 * {@link scannedCliCommands} is so it inherits the same blind spot and the
 * commander tree can expose it.
 */
function scannedCliOptions() {
  const names = new Set();
  const add = (declaration) => {
    for (const flag of declaration.matchAll(/--([a-z][a-z0-9-]*)/g)) names.add(flag[1]);
  };
  for (const file of sourceFilesUnder(CLI_SRC)) {
    if (isTestPath(rel(file))) continue;
    const source = textOf(file);
    for (const match of source.matchAll(/\.(?:option|requiredOption|addOption)\(\s*[`"']([^`"']+)[`"']/g))
      add(match[1]);
    for (const match of source.matchAll(/new Option\(\s*"([^"]+)"/g)) add(match[1]);
  }
  return names;
}

/**
 * Options this gate does not require documentation for, each with the reason it
 * is not required — the `NOT_CLAIMS` shape, for the same purpose: an option may
 * leave the checked set only by an argument on the record, never by being
 * forgotten.
 *
 * It is empty, and that is the finding rather than an oversight. 124 of the
 * CLI's 142 options are already documented in both languages; the rule below
 * asks for eighteen more lines, not a hundred and forty-two, so there is no
 * option today whose documentation is not worth writing. The derivable opt-out
 * is `hidden` (see below) and it should be preferred to an entry here, because
 * hiding an option turns off `--help`'s advertisement of it too — an option
 * users are told about but the documentation skips is the drift this gate is
 * for.
 */
const OPTIONS_NOT_DOCUMENTED = new Map([]);

/** The registered long options, with the commands each is declared on. */
async function cliOptions() {
  const tree = await commandTree;
  const sites = new Map();
  for (const site of tree.optionSites ?? []) {
    if (!sites.has(site.name)) sites.set(site.name, []);
    sites.get(site.name).push(site);
  }
  return sites;
}

/**
 * The self-check for the option surface, in the direction that matters.
 *
 * The two sides are produced by different machinery on purpose: a regex over
 * `apps/cli/src`, and the option registry of the program commander actually
 * built. `scanned \ registered` is a dead registrar — an `.option()` call in a
 * module the entry point no longer imports, whose flag the CLI would reject.
 * `registered \ scanned` is the coverage direction, and it is non-empty today:
 * `-V, --version` comes from `program.version()`, which no `.option(` literal
 * spells out. That is the same "no regex can read a name that is not a
 * literal" shape as the `schedule install` trio, and it is why the
 * documentation check below consumes commander's list rather than this grep.
 * Commander marks its own generated option, so the exemption is a fact read
 * back off the tree rather than a `--version` string in an ignore list.
 */
test("the CLI options this gate scans are the options commander registers", async () => {
  const sites = await cliOptions();
  assert.ok(sites.size > 100, `commander reports only ${sites.size} options; the probe is not seeing the real program`);
  const scanned = scannedCliOptions();

  const invisible = [...scanned].filter((name) => !sites.has(name)).sort();
  assert.deepEqual(
    invisible,
    [],
    "the sources declare these options but the program commander builds does not have them — " +
      "either the entry point no longer imports their registrar (the option is dead) or the probe cannot see it",
  );

  const unscanned = [...sites.keys()]
    .filter((name) => !scanned.has(name) && !sites.get(name).some((site) => site.builtin))
    .sort();
  assert.deepEqual(
    unscanned,
    [],
    "commander registers these options but no `.option()`/`new Option()` literal in apps/cli/src spells them out, " +
      "and commander did not generate them either — find where they are registered before trusting any text scan " +
      "of the option surface",
  );
});

test("every CLI option appears in both languages of documentation", async () => {
  const sites = await cliOptions();
  for (const [name, reason] of OPTIONS_NOT_DOCUMENTED) {
    assert.ok(sites.has(name), `--${name} is exempted from the option documentation check but is not registered`);
    assert.ok(reason.length > 20, `--${name} is exempted from the option documentation check without a reason`);
  }

  // Which options must be documented, as a rule rather than a list:
  //
  //   - every long option the program registers, because the alternative rules
  //     all lose one of the four flags this check was written for. "Only
  //     value-taking options" drops `--auto-rollback`, a boolean that decides
  //     whether a regressed deployment is rolled back. "Only options on
  //     documented commands" is circular. "Only options outside a common core"
  //     needs the list of the common core, which is the hand-maintained
  //     allowlist this gate exists to not have.
  //   - minus the ones commander hides from `--help`, because an option the
  //     program itself does not advertise is not a user surface. Nothing is
  //     hidden today; this is the lever to reach for when something should be
  //     internal, and it is derivable, unlike the map above.
  const required = [...sites.entries()].filter(
    ([name, declarations]) => !declarations.every((site) => site.hidden) && !OPTIONS_NOT_DOCUMENTED.has(name),
  );
  assert.ok(required.length > 100, `expected the CLI to register many documented options, found ${required.length}`);

  // Both languages, and the same corpus the subcommand check uses — any page of
  // that language, not `docs/cli-reference.md` alone. 51 of the 142 options are
  // documented where their capability lives instead (`--cron` and `--every` in
  // the scheduling guide, `--host` and `--port` in the remote guide), and a gate
  // that demanded a second home for all of them would be asking for the
  // reference page to be a duplicate of every topic page. Both languages is not
  // an extra demand: all 124 options documented today are documented in both, so
  // this holds the line that already exists — the same reason the config-key
  // check asks for both configuration guides.
  for (const [chinese, label] of [
    [false, "English documentation"],
    [true, "Chinese documentation"],
  ]) {
    const spans = docCorpus(chinese).join("\n");
    const missing = [];
    for (const [name, declarations] of required) {
      // `[^a-z0-9-]`, not `\b`: `--out` is not documented by a page that
      // mentions `--output-format`, and eleven of these names prefix another.
      if (new RegExp(`--${name}(?![a-z0-9-])`).test(spans)) continue;
      const where = [...new Set(declarations.map((site) => `seekforge ${site.command}`.trim()))].join(", ");
      const description = declarations.find((site) => site.description)?.description ?? "";
      missing.push(`--${name} (${where})${description ? ` — ${description}` : ""}`);
    }
    assert.deepEqual(
      missing.sort(),
      [],
      `${label} never mentions these options — an undocumented flag is one nobody can find; ` +
        "document each on the page its command lives on, or hide it from `--help` if it is internal",
    );
  }
});

// ---------------------------------------------------------------------------
// The environment-variable surface.
//
// Nothing walked this direction at all. `doc-claim-reachability.test.mjs` fails
// when a page names a `SEEKFORGE_*` variable nothing reads; no check failed when
// the program read one no page names, which is how `SEEKFORGE_NO_BROWSER` — the
// knob that makes `seekforge mcp login` work on a headless box — came to be
// described only in a comment above the line that reads it.
// ---------------------------------------------------------------------------

/**
 * Trees whose environment variables are not a user surface, each with the
 * reason — the `NOT_SOURCE` shape, and the test below keeps the two sets a
 * partition of the repository so a new tree lands in the scanned half by
 * default.
 */
const ENV_NOT_SOURCE = new Map([
  ["scripts", "the repository's own CI and gate tooling; it ships in no package, and its knobs configure builds"],
  ["evals", "fixture repositories the eval tasks run against — inputs, not surfaces"],
  ["spikes", "throwaway experiments, explicitly not shipped"],
]);

const ENV_NAME = "SEEKFORGE_[A-Z0-9_]+";

/**
 * The `SEEKFORGE_*` names that cross the process boundary, and how.
 *
 * Two directions, both of them a public contract:
 *
 *   - **read**: `process.env.NAME`, `env["NAME"]` on a parameter the caller
 *     defaults to `process.env`, or Rust's `std::env::var("NAME")`. These are
 *     inputs a user sets.
 *   - **written**: a name assigned into an environment a child process is
 *     spawned with — the statusline script's seven fields and the two the hook
 *     runner exports. These are outputs a user's script reads, and leaving them
 *     out would exempt a contract that exists precisely to be consumed
 *     externally.
 *
 * `declared` is the third bucket and the reason the reader can be strict: a
 * `SEEKFORGE_*` token can also be an ordinary identifier (`SEEKFORGE_VERSION`,
 * `SEEKFORGE_PROTOCOL_VERSION` are exported consts), and demanding
 * documentation for those would make this gate cry wolf. Everything else is
 * reported by the self-check below rather than silently dropped.
 */
let environmentCache;
function environmentSurface() {
  if (environmentCache) return environmentCache;
  const record = (map, name, file, source, index) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(`${file}:${source.slice(0, index).split("\n").length}`);
  };
  const read = new Map();
  const written = new Map();
  const declared = new Set();
  const mentioned = new Set();
  const files = [];
  for (const file of trackedSourceFiles()) {
    if (ENV_NOT_SOURCE.has(file.split("/")[0])) continue;
    files.push(file);
    const source = textOf(join(root, file));
    if (!source.includes("SEEKFORGE_")) continue;
    for (const match of source.matchAll(new RegExp(`\\b(${ENV_NAME})\\b`, "g"))) mentioned.add(match[1]);
    for (const match of source.matchAll(new RegExp(`\\b(?:export\\s+)?(?:const|let|static)\\s+(${ENV_NAME})\\b`, "g")))
      declared.add(match[1]);
    // An access site is a read unless it is the target of an assignment, which
    // is how `process.env["SEEKFORGE_PROFILE"] = cliProfile` in the entry point
    // is counted as the export it is rather than as a knob the CLI reads.
    for (const match of source.matchAll(
      new RegExp(`(?:process\\.)?\\benv(?:\\.(${ENV_NAME})|\\[\\s*["'](${ENV_NAME})["']\\s*\\])`, "g"),
    )) {
      const name = match[1] ?? match[2];
      const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 4);
      record(/^\s*=[^=]/.test(tail) ? written : read, name, file, source, match.index);
    }
    for (const match of source.matchAll(new RegExp(`std::env::var(?:_os)?\\(\\s*"(${ENV_NAME})"`, "g")))
      record(read, match[1], file, source, match.index);
    // The object-literal form, which is how every child-process environment in
    // this repository is built: `{ SEEKFORGE_TOOL: toolName ?? "" }`.
    for (const match of source.matchAll(new RegExp(`^\\s*(${ENV_NAME})\\s*:`, "gm")))
      record(written, match[1], file, source, match.index);
  }
  environmentCache = { read, written, declared, mentioned, files };
  return environmentCache;
}

/**
 * The environment scan reads every tracked source tree and subtracts
 * `ENV_NOT_SOURCE`, so a tree added tomorrow is scanned by default and has to
 * be argued out rather than into the surface. What still needs asserting is
 * the other end: that each exclusion is current and reasoned, because a stale
 * one is an exemption nobody is defending — and that the trees which do ship
 * are in fact among the scanned.
 */
test("every source tree is either scanned for environment variables or excluded on the record", () => {
  const trees = new Set(trackedSourceFiles().map((file) => file.split("/")[0]));
  for (const [tree, reason] of ENV_NOT_SOURCE) {
    // `existsSync`, not membership in `trees`: `evals/` is entirely fixtures,
    // which the test-path filter already removes, and an exclusion that reads
    // as stale the moment it is also covered another way is an exclusion
    // somebody will delete for the wrong reason.
    assert.ok(existsSync(join(root, tree)), `${tree}/ is excluded from the environment scan but no longer exists`);
    assert.ok(reason.length > 20, `${tree}/ is excluded from the environment scan without a reason`);
  }
  const scanned = [...trees].filter((tree) => !ENV_NOT_SOURCE.has(tree)).sort();
  for (const shipped of ["apps", "packages", "crates"]) {
    assert.ok(scanned.includes(shipped), `${shipped}/ is not in the environment scan: ${scanned.join(", ")}`);
  }
});

/**
 * The self-check for the environment surface: every `SEEKFORGE_*` token the
 * shipped source contains must be classified, or the documentation check below
 * is silently running on a subset.
 *
 * This is the part a regex over `process.env.` cannot promise on its own. A
 * name read through a helper that takes it as a parameter —
 * `packages/shared/src/doctor.ts` hands its probes `env: (key) => process.env[key]`
 * — appears in no access site the reader recognizes, and would otherwise drop
 * out of the surface without a word. Here it fails instead, and whoever added
 * it decides which bucket it belongs in.
 */
test("every SEEKFORGE_* name in the shipped source is classified", () => {
  const { read, written, declared, mentioned, files } = environmentSurface();
  assert.ok(files.length > 500, `expected the environment scan to read the repository, found ${files.length} files`);
  assert.ok(read.size > 5, `expected the program to read several SEEKFORGE_* variables, found ${read.size}`);
  const unclassified = [...mentioned]
    .filter((name) => !read.has(name) && !written.has(name) && !declared.has(name))
    .sort();
  assert.deepEqual(
    unclassified,
    [],
    "these SEEKFORGE_* names appear in shipped source but at no site this reader understands — it can see " +
      '`process.env.NAME`, `env["NAME"]`, `std::env::var("NAME")`, a `NAME:` entry in a child environment and ' +
      "a `const NAME` declaration, and nothing else; if one of these is read through a helper that takes the name " +
      "as an argument, the documentation check never asks for it",
  );
});

test("every environment variable the program reads or exports is documented in both languages", () => {
  const { read, written } = environmentSurface();
  const surface = [...new Set([...read.keys(), ...written.keys()])].sort();
  assert.ok(surface.length > 10, `expected the program to expose many SEEKFORGE_* variables, found ${surface.length}`);
  for (const [chinese, label] of [
    [false, "English documentation"],
    [true, "Chinese documentation"],
  ]) {
    // The same corpus as the option and subcommand checks. It deliberately does
    // not include `apps/desktop/src-tauri/README.md`, which is the only page
    // naming `SEEKFORGE_SERVE_CMD`, `SEEKFORGE_WORKSPACE` and
    // `SEEKFORGE_STATIC_DIR`: that page is a build note for the Tauri shell, it
    // has no Chinese counterpart, and a reader configuring SeekForge from
    // `docs/configuration.md` has no path to it.
    const spans = docCorpus(chinese).join("\n");
    const missing = surface
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(spans))
      .map((name) => `${name} (${[...(read.get(name) ?? written.get(name))].sort().join(", ")})`);
    assert.deepEqual(
      missing,
      [],
      `${label} never mentions these environment variables — a knob documented only next to the line that ` +
        "reads it is a knob nobody can set; document each in the configuration guide",
    );
  }
});
