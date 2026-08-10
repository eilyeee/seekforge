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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

/** Top-level CLI commands, i.e. `program.command("name")` anywhere in the CLI. */
function cliCommands() {
  const dir = join(root, "apps", "cli", "src", "commands");
  const sources = [read("apps", "cli", "src", "index.ts")];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".ts") && !name.includes(".test.")) sources.push(readFileSync(join(dir, name), "utf8"));
  }
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/program\s*\n?\s*\.command\(\s*"([a-z][a-z-]*)"/g)) names.add(match[1]);
  }
  return names;
}

test("every top-level CLI command appears in both README command tables", () => {
  const commands = cliCommands();
  assert.ok(commands.size > 10, `expected the CLI to register many commands, found ${commands.size}`);
  for (const [file, label] of [
    ["README.md", "English README"],
    ["README.zh-CN.md", "Chinese README"],
  ]) {
    const source = read(file);
    for (const command of commands) {
      assert.ok(
        new RegExp(`\`seekforge [^\`]*\\b${command}\\b`).test(source),
        `${label} has no row for \`seekforge ${command}\` — document it or the command is undiscoverable`,
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
function cliSubcommands() {
  const files = [["apps", "cli", "src", "index.ts"]];
  for (const dir of [
    ["apps", "cli", "src"],
    ["apps", "cli", "src", "commands"],
  ]) {
    for (const name of readdirSync(join(root, ...dir))) {
      if (name.endsWith(".ts") && !name.includes(".test.")) files.push([...dir, name]);
    }
  }
  const pairs = new Map();
  for (const parts of files) {
    const source = readFileSync(join(root, ...parts), "utf8");
    // `const graph = program.command("graph")` and `const template = graph.command("template")`.
    const groups = new Map([["program", []]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [, variable, parent, name] of source.matchAll(
        /const\s+(\w+)\s*=\s*(\w+)\s*\.command\(\s*"([a-z][a-z-]*)"/g,
      )) {
        if (groups.has(variable) || !groups.has(parent)) continue;
        groups.set(variable, [...groups.get(parent), name]);
        grew = true;
      }
    }
    for (const [, parent, name] of source.matchAll(/(\w+)\s*\.command\(\s*"([a-z][a-z-]*)"/g)) {
      const path = groups.get(parent);
      // Only nested commands; `program.command("x")` is the top-level check's job.
      if (!path || path.length === 0) continue;
      const key = path.join(" ");
      if (!pairs.has(key)) pairs.set(key, new Set());
      pairs.get(key).add(name);
    }
  }
  return pairs;
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

test("every CLI subcommand appears in both languages of documentation", () => {
  const groups = cliSubcommands();
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
 * Config keys every surface declares. This used to read `CliConfig` alone, so a
 * key that only the server or the TUI honors was unguarded — `runRetentionMaxCount`,
 * `accent`, `bell`, `vim` and friends were live, effective, and documented nowhere.
 */
function configKeys() {
  const sources = [
    [["apps", "cli", "src", "config.ts"], "export type CliConfig = {"],
    [["apps", "tui", "src", "config.ts"], "export type TuiConfig = {"],
    [["apps", "server", "src", "config.ts"], "export type ServerConfig = {"],
  ];
  const keys = new Set();
  for (const [parts, marker] of sources) {
    const source = read(...parts);
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `could not find ${marker}`);
    const body = source.slice(at);
    const end = body.indexOf("\n};");
    assert.ok(end > 0, `could not find the end of ${marker}`);
    for (const match of body.slice(0, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) keys.add(match[1]);
  }
  return keys;
}

test("every config key is documented in both configuration guides", () => {
  const keys = configKeys();
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

test("every REST route path is described in SERVER-API.md", () => {
  const dir = join(root, "apps", "server", "src", "routes");
  const documented = read("apps", "server", "SERVER-API.md");
  const missing = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const source = readFileSync(join(dir, name), "utf8");
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

/** Flat i18n tables keyed by locale, as used by the CLI, TUI, and Desktop. */
function localeTables(source) {
  const tables = {};
  for (const match of source.matchAll(/^ {2}(en|"zh-CN"|zh):\s*\{$/gm)) {
    const locale = match[1].replaceAll('"', "");
    const body = source.slice(match.index + match[0].length);
    const end = body.indexOf("\n  },");
    tables[locale] = new Set([...body.slice(0, end).matchAll(/^\s{4}"([^"]+)":/gm)].map((entry) => entry[1]));
  }
  return tables;
}

/**
 * The TUI keeps its table as two top-level consts rather than one nested
 * object, so it needs its own reader. Same data, different shape.
 */
function constTables(source, names) {
  const tables = {};
  for (const [locale, name] of Object.entries(names)) {
    const at = source.indexOf(`const ${name}`);
    if (at < 0) continue;
    const body = source.slice(at);
    const end = body.indexOf("\n};");
    tables[locale] = new Set([...body.slice(0, end).matchAll(/^\s+"([^"]+)":/gm)].map((entry) => entry[1]));
  }
  return tables;
}

/** Every localized surface: where its tables live and where they are read. */
const I18N_SURFACES = [
  {
    name: "cli",
    src: ["apps", "cli", "src"],
    tables: [
      ["apps", "cli", "src", "i18n", "common.ts"],
      ["apps", "cli", "src", "i18n", "commands.ts"],
      ["apps", "cli", "src", "i18n", "repl.ts"],
    ],
    read: (source) => localeTables(source),
  },
  {
    name: "tui",
    src: ["apps", "tui", "src"],
    tables: [["apps", "tui", "src", "strings.ts"]],
    read: (source) => constTables(source, { en: "EN", "zh-CN": "ZH_CN" }),
  },
  {
    name: "desktop",
    src: ["apps", "desktop", "src"],
    tables: [
      ["apps", "desktop", "src", "lib", "i18n", "common.ts"],
      ["apps", "desktop", "src", "lib", "i18n", "views.ts"],
      ["apps", "desktop", "src", "lib", "i18n", "chat.ts"],
    ],
    read: (source) => localeTables(source),
  },
];

test("i18n tables define the same keys in every locale", () => {
  for (const surface of I18N_SURFACES) {
    for (const parts of surface.tables) {
      const tables = surface.read(read(...parts));
      const locales = Object.keys(tables);
      assert.ok(locales.includes("en"), `${parts.join("/")} has no English table`);
      assert.ok(locales.length > 1, `${parts.join("/")} has no translation table`);
      for (const locale of locales) {
        if (locale === "en") continue;
        const missing = [...tables.en].filter((key) => !tables[locale].has(key));
        const extra = [...tables[locale]].filter((key) => !tables.en.has(key));
        assert.deepEqual(missing, [], `${parts.join("/")}: ${locale} is missing keys`);
        assert.deepEqual(extra, [], `${parts.join("/")}: ${locale} has keys English does not`);
      }
    }
  }
});

/**
 * Every .ts/.tsx under a directory, recursively, minus the i18n tables
 * themselves.
 *
 * `exclude` is a set of absolute table paths rather than a directory-name
 * convention, because the convention only holds for two of the three surfaces:
 * the CLI and the Desktop keep their tables under an `i18n/` directory, and the
 * TUI keeps its in `strings.ts`, a plain file among its other modules. Skipping
 * by directory name therefore left the TUI's table IN the corpus being
 * searched — and since the check asks whether a key appears as `"key"`
 * anywhere, every key matched its own definition line and the whole dead-key
 * test was a no-op for that surface. It reported zero and could report nothing
 * else.
 */
function sourceFiles(dir, exclude, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") sourceFiles(full, exclude, out);
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !exclude.has(full)) {
      out.push(full);
    }
  }
  return out;
}

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
  for (const surface of I18N_SURFACES) {
    const keys = new Set();
    for (const parts of surface.tables) {
      for (const key of surface.read(read(...parts)).en) keys.add(key);
    }
    const tableFiles = new Set(surface.tables.map((parts) => join(root, ...parts)));
    const source = sourceFiles(join(root, ...surface.src), tableFiles)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const dynamic = dynamicKeyPrefixes(source);
    const unused = [...keys]
      .filter((key) => !source.includes(`"${key}"`) && !dynamic.some((prefix) => key.startsWith(prefix)))
      .sort();
    assert.deepEqual(unused, [], `${surface.name}: i18n keys defined in both languages but read by nobody`);
  }
});
