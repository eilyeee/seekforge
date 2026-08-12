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
