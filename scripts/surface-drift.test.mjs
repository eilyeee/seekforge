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

/** Config keys declared by the CLI's CliConfig type. */
function configKeys() {
  const source = read("apps", "cli", "src", "config.ts");
  const body = source.slice(source.indexOf("export type CliConfig = {"));
  const end = body.indexOf("\n};");
  assert.ok(end > 0, "could not find the end of CliConfig");
  const keys = new Set();
  for (const match of body.slice(0, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) keys.add(match[1]);
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
    for (const key of keys) {
      assert.ok(
        source.includes(`\`${key}\``),
        `${label} never mentions the \`${key}\` config key — an undocumented key is an unusable one`,
      );
    }
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

test("i18n tables define the same keys in every locale", () => {
  const files = [
    ["apps", "cli", "src", "i18n", "common.ts"],
    ["apps", "cli", "src", "i18n", "commands.ts"],
    ["apps", "cli", "src", "i18n", "repl.ts"],
  ];
  for (const parts of files) {
    const tables = localeTables(read(...parts));
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
});

/** Every .ts under a directory, recursively, excluding the i18n tables themselves. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n" && entry.name !== "node_modules" && entry.name !== "dist") sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

test("every i18n key is actually used somewhere", () => {
  // The parity test above proves both languages define the same keys. It says
  // nothing about whether anyone reads them, and 30 of 299 turned out to be
  // dead: 13 because the doctor checks moved into @seekforge/shared and their
  // translations did not follow — so `seekforge doctor` printed English details
  // under a Chinese header — and 17 left behind by a namespace rename, still
  // translated in both languages, superseded by keys under a newer prefix.
  //
  // Both failure modes are invisible: a dead key is not an error, it is a
  // translation nobody sees, and the English fallback looks like a missing
  // translation rather than a wiring bug.
  const keys = new Set();
  for (const name of ["common.ts", "commands.ts", "repl.ts"]) {
    const tables = localeTables(read("apps", "cli", "src", "i18n", name));
    for (const key of tables.en) keys.add(key);
  }
  // Keys are always written as string literals at the call site, including the
  // `const key = cond ? "a" : "b"` form, so a literal scan is exact.
  const source = sourceFiles(join(root, "apps", "cli", "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const unused = [...keys].filter((key) => !source.includes(`"${key}"`)).sort();
  assert.deepEqual(unused, [], "i18n keys defined in both languages but read by nobody");
});
