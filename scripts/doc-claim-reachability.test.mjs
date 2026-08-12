// Reachability checks in the direction the other gates do not run: from the
// documentation back to a real entry point.
//
// `surface-drift.test.mjs` walks code -> docs. It fails when a shipped command,
// config key or REST route is undocumented. It cannot see the opposite defect,
// which has now shipped three times in a row: a capability that is implemented,
// unit-tested and written up in both languages, but that no user can reach
// because nothing calls it.
//
//   - `createGitLabCiProvider` had an implementation, tests and docs; the
//     injection point was never set by any caller, and no flag, config key or
//     environment variable could set it.
//   - `verifyLoopEvidenceIntegrity` existed as a definition line and an export
//     line and nothing else, while the docs promised evidence reports came with
//     a "Core verification tool".
//   - The provider's text-protocol fallback had zero consumers while the README
//     described how it behaved.
//
// Every one of those is the same shape: the documentation makes a claim, and
// the claim does not terminate at an entry point. An entry point here is a CLI
// command or option, a REST route, a TUI slash command, a Desktop call, or an
// export the embedder guide (`docs/sdk.md`) introduces as an API.
//
// Design rule for this file: a noisy gate is worse than no gate, because people
// learn to ignore it. Every check below is deliberately built to under-report.
// When a rule could not distinguish a real gap from a documentation idiom, the
// rule was narrowed until it could, even at the cost of missing real gaps. See
// the "What this file cannot see" note at the bottom.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { isTestPath, root, sourceFilesUnder, workspacePackages } from "./surface-registry.mjs";

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

/**
 * Every Markdown page in the working tree that git would keep — tracked files
 * plus new ones not covered by .gitignore. Ignored output (eval reports,
 * `.seekforge/` session summaries) is not documentation, and asking git rather
 * than filtering directory names by hand is why that distinction needs no list.
 * `--others` matters: a page added in this commit must be classified now, not
 * on the next CI run.
 */
function trackedFiles(...patterns) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...patterns], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

/**
 * Pages that are deliberately NOT read as claims, each with the reason it is
 * not one. Nothing may be silently unread: the test below requires every
 * tracked Markdown file to be either a claims page or an entry here, so a new
 * documentation directory fails the gate until somebody decides which it is.
 * The old version read `README*.md` plus `docs/*.md` and nothing else, which
 * left `apps/cli/README.md` — the page npm shows on the package listing, with
 * twenty `seekforge …` invocations in it — checked by nobody, and said so
 * nowhere.
 */
const NOT_CLAIMS = new Map([
  ["AGENTS.md", "instructions to contributors; names internals and gate scripts, promises a user nothing"],
  ["CHANGELOG.md", "history: it names commands and flags as they were, including ones since removed"],
  [
    "docs/boundary-checklist.md",
    "an engineering log of bug *classes*: it quotes internal helpers, deleted code and hypothetical snippets " +
      "(`setsid`, `closeBrowser`, `foo_bar`, `/var`), none of which is a promise to a user — it produced every " +
      "false positive in the first pass of this file",
  ],
  ["docs/boundary-checklist.zh-CN.md", "translation of the boundary checklist"],
  ["docs/roadmap.md", "describes work that has not shipped, so naming a symbol there is a plan, not a claim"],
  ["docs/roadmap.zh-CN.md", "translation of the roadmap"],
  [
    "apps/tui/README.md",
    'a scope document. It states what the TUI deliberately does NOT implement ("The TUI has no `/graph-run`") ' +
      "in the same code spans it uses for what it does, and a reachability walk cannot tell a negative claim " +
      "from a positive one",
  ],
  ["apps/tui/DESIGN.md", "the TUI's design rationale, same negative-claim idiom as its README"],
  ["evals/README.md", "how to run the eval harness against fixtures; the fixtures are inputs, not surfaces"],
  ["evals/round-52-measurements.md", "a measurement log of one eval round"],
  ["spikes/README.md", "throwaway experiments, explicitly not shipped"],
]);

const FIXTURE_PAGE = /^evals\/fixtures\//;

/** Pages that make claims about what a user can reach. */
function docPages() {
  return trackedFiles("*.md").filter((page) => !NOT_CLAIMS.has(page) && !FIXTURE_PAGE.test(page));
}

test("every documentation page is either read as a claim or excluded on the record", () => {
  const pages = docPages();
  assert.ok(pages.length > 20, `expected many documentation pages, found ${pages.length}`);
  const stale = [...NOT_CLAIMS.keys()].filter((page) => !existsSync(join(root, page)));
  assert.deepEqual(stale, [], "these pages are excluded from the claims corpus but no longer exist");
  // Nothing to assert about `pages` itself — the point is that the two sets
  // partition the tracked Markdown, so a page added anywhere lands in the read
  // set by default and has to be argued out of it rather than into it.
  for (const page of pages) {
    assert.ok(!NOT_CLAIMS.has(page), `${page} is both read and excluded`);
  }
});

/**
 * Source trees whose code can make a documented claim reachable.
 *
 * Derived from the workspace globs rather than listed, plus the two source
 * trees that are not packages. `.cjs` counts: the VS Code extension is written
 * in it, and an extension-only consumer used to look like no consumer at all.
 */
function sourceRoots() {
  const parents = new Set(workspacePackages().map((pkg) => dirname(pkg.dir)));
  for (const extra of ["scripts", "examples"]) {
    if (existsSync(join(root, extra))) parents.add(join(root, extra));
  }
  return [...parents].sort();
}

/**
 * The scanned roots must cover every source tree in the repository, or a
 * documented symbol whose only caller lives outside them reads as dead.
 * `evals/` and `spikes/` are the two trees deliberately left out: the eval
 * fixtures are miniature repositories the agent is run *against*, so their
 * code calling something would not make it reachable for a user, and spikes
 * are experiments that ship to nobody.
 */
const NOT_SOURCE = new Map([
  ["evals", "fixture repositories the eval tasks run against — inputs, not surfaces"],
  ["spikes", "throwaway experiments, explicitly not shipped"],
]);

test("every source tree in the repository is either scanned or excluded on the record", () => {
  const tracked = trackedFiles("*.ts", "*.tsx", "*.mts", "*.cts", "*.mjs", "*.cjs", "*.js");
  const scanned = new Set(sourceRoots().map((dir) => dir.slice(root.length + 1)));
  const unscanned = [...new Set(tracked.map((file) => file.split("/")[0]))]
    .filter((top) => !scanned.has(top) && !NOT_SOURCE.has(top))
    .sort();
  assert.deepEqual(
    unscanned,
    [],
    "these top-level directories hold source this gate never reads, so a symbol they are the only consumer of " +
      "reads as unreachable — add them to sourceRoots() or to NOT_SOURCE with the reason",
  );
});

/** Every source file under `dir`, recursively, skipping build output. */
const sourceFiles = (dir) => sourceFilesUnder(dir);

const isTestFile = (rel) => isTestPath(rel);

/** Line number (1-based) of a match offset, for a report a human can act on. */
const lineAt = (source, index) => source.slice(0, index).split("\n").length;

// ---------------------------------------------------------------------------
// 1. A symbol the documentation names must have a live consumer.
// ---------------------------------------------------------------------------

/**
 * Every exported symbol in the workspace, mapped to the files that declare it.
 *
 * Only `export <keyword> <name>` declarations count. Re-export barrels are
 * deliberately not treated as declarations: `verifyLoopEvidenceIntegrity` was
 * dead for weeks while appearing in `agent/index.ts`, and a barrel line is
 * exactly the evidence that must not count as use.
 */
function exportedSymbols(files) {
  const declared = new Map();
  for (const file of files) {
    const rel = file.slice(root.length + 1);
    for (const match of readFileSync(file, "utf8").matchAll(
      /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum|let)\s+([A-Za-z][A-Za-z0-9_]*)/gm,
    )) {
      if (!declared.has(match[1])) declared.set(match[1], []);
      declared.get(match[1]).push(rel);
    }
  }
  return declared;
}

/**
 * The transitive export surface of a package entry point, following
 * `export * from` and named re-exports. Used to decide whether a symbol the
 * embedder guide introduces is actually reachable by an embedder.
 */
function packageSurface(entry, seen = new Set(), names = new Set()) {
  const file = existsSync(entry) ? entry : entry.replace(/\.js$/, ".ts");
  if (seen.has(file) || !existsSync(file)) return names;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum|let)\s+([A-Za-z][A-Za-z0-9_]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\*\s*from\s*"([^"]+)"/gm)) {
    packageSurface(resolve(dirname(file), match[1]), seen, names);
  }
  for (const match of source.matchAll(/^export\s*(?:type\s*)?\{([\s\S]*?)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Does any shipped, non-test line actually *use* this symbol?
 *
 * "Use" excludes the four line shapes that look like use and are not, each of
 * which produced false positives before it was excluded:
 *   - the declaration itself;
 *   - `import ...` and `export {` / `export *` / `export type {` statements,
 *     because a barrel re-export is the exact evidence of a dead symbol;
 *   - every line of a multi-line `import { … }` / `export { … }` list;
 *   - comments, including the JSDoc that describes the symbol.
 *
 * The brace-list skip is tracked as a state, not guessed from the line: an
 * earlier version skipped any bare `name,` line, which also skipped the
 * one-symbol-per-line registration tables the tool layer is built from
 * (`browserClick,` inside `export const browserTools = [ … ]`) and reported ten
 * live browser tools as dead.
 *
 * Use *inside the declaring file* counts. Requiring an external caller flagged
 * `proposeDurableRule`, `normalizeNumericIpv4`, `encodeLspMessage`,
 * `parseLspMessages` and `hashDataset`, all of which are called by the exported
 * behavior of their own module and are perfectly reachable. Conversely, a line
 * beginning with `export` is only skipped when it is an import/export
 * *statement*: skipping all of them hid `startServer(opts: StartServerOptions)`
 * and `createDockerRunner(): AgentRunner`, so both types were reported dead.
 */
function findUse(name, declaredIn, lines) {
  const mentions = new RegExp(`\\b${name}\\b`);
  const declares = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|class|type|interface|enum|let)\\s+${name}\\b`,
  );
  for (const [rel, fileLines] of lines) {
    if (isTestFile(rel)) continue;
    let inBraceList = false;
    for (const [index, line] of fileLines.entries()) {
      const text = line.trim();
      if (inBraceList) {
        if (text.includes("}")) inBraceList = false;
        continue;
      }
      if (/^(?:import|export)\s*(?:type\s*)?\{/.test(text) && !text.includes("}")) {
        inBraceList = true;
        continue;
      }
      if (!mentions.test(line)) continue;
      if (declaredIn.includes(rel) && declares.test(text)) continue;
      if (/^import\b/.test(text)) continue;
      if (/^export\s*(?:\*|\{|type\s*\{)/.test(text)) continue;
      if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) continue;
      return `${rel}:${index + 1}`;
    }
  }
  return undefined;
}

test("every symbol the documentation names is consumed by something that ships", () => {
  const files = sourceRoots().flatMap((dir) => sourceFiles(dir));
  const declared = exportedSymbols(files);
  const lines = new Map(files.map((file) => [file.slice(root.length + 1), readFileSync(file, "utf8").split("\n")]));

  // Candidates are identifiers with an interior camel hump, which is what a
  // symbol reference looks like and what ordinary prose does not. Extraction
  // runs over the whole page rather than only over code spans: the claim that
  // sank `verifyLoopEvidenceIntegrity` was a sentence, not a fenced block.
  // Whether a word is a claim is then decided by whether the workspace exports
  // a symbol with that exact name — that filter takes ~1100 doc tokens down to
  // ~135 and removes every user-supplied example name, npm package and builtin
  // in one step, without a hand-maintained ignore list.
  const claims = new Map();
  for (const page of docPages()) {
    const source = read(page);
    for (const match of source.matchAll(/\b([a-zA-Z][A-Za-z0-9]{5,})\b/g)) {
      const name = match[1];
      if (!/[a-z][A-Z]/.test(name) || !declared.has(name)) continue;
      if (!claims.has(name)) claims.set(name, []);
      claims.get(name).push(`${page}:${lineAt(source, match.index)}`);
    }
  }
  assert.ok(claims.size > 80, `expected the docs to name many workspace symbols, found ${claims.size}`);

  // `docs/sdk.md` introduces exports as an embedder API. That is an entry point
  // in its own right, so an in-repo caller is not required — but only if the
  // symbol is genuinely importable from the package entry point the guide
  // promises ("Every name below is a real export from packages/core/src/index.ts").
  // Without that second half the exemption would launder any dead symbol whose
  // name someone dropped into the SDK guide.
  const embedderApi = new Set();
  for (const page of ["docs/sdk.md", "docs/sdk.zh-CN.md"]) {
    for (const match of read(page).matchAll(/\b([a-zA-Z][A-Za-z0-9]{5,})\b/g)) embedderApi.add(match[1]);
  }
  const coreSurface = packageSurface(join(root, "packages", "core", "src", "index.ts"));

  const unreachable = [];
  for (const [name, where] of claims) {
    if (findUse(name, declared.get(name), lines)) continue;
    if (embedderApi.has(name) && coreSurface.has(name)) continue;
    unreachable.push(`${name} (${declared.get(name).join(", ")}) — documented at ${where.slice(0, 2).join(", ")}`);
  }
  assert.deepEqual(
    unreachable.sort(),
    [],
    "documented symbols with no consumer: nothing in apps/, packages/, scripts/ or examples/ calls them, and " +
      "docs/sdk.md does not offer them as an embedder export — the documentation describes a capability no user can reach",
  );
});

// ---------------------------------------------------------------------------
// 2. A documented command line must resolve to a registered command and options.
// ---------------------------------------------------------------------------

/** Command names and option flags the CLI actually registers. */
function cliVocabulary() {
  const source = sourceFiles(join(root, "apps", "cli", "src"))
    .filter((file) => !isTestFile(file.slice(root.length + 1)))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const commands = new Set();
  for (const match of source.matchAll(/\.command\(\s*"([a-z][a-z0-9-]*)"/g)) commands.add(match[1]);
  for (const match of source.matchAll(/\.alias\(\s*"([a-z][a-z0-9-]*)"/g)) commands.add(match[1]);
  const flags = new Set();
  // Options that take a required value, e.g. `--output-format <fmt>`. The
  // parser below has to know: in `seekforge -p "…" --output-format json` the
  // word `json` is that option's value, and reading it as the command word
  // reported `seekforge json` as an unregistered command.
  const valued = new Set();
  const declaration = (text) => {
    const names = [...text.matchAll(/(--[a-z][a-z0-9-]*|-[a-zA-Z])/g)].map((flag) => flag[1]);
    for (const name of names) if (name.startsWith("--")) flags.add(name.slice(2));
    if (/<[^>]+>/.test(text)) for (const name of names) valued.add(name);
  };
  for (const match of source.matchAll(/\.(?:option|requiredOption|addOption)\(\s*[`"']([^`"']+)[`"']/g)) {
    declaration(match[1]);
  }
  for (const match of source.matchAll(/new Option\(\s*"([^"]+)"/g)) declaration(match[1]);
  return { commands, flags, valued };
}

/** Inline code spans plus the lines of the named fences, with line numbers. */
function codeClaims(source, fenceLanguages) {
  const claims = [];
  for (const match of source.matchAll(/`([^`\n]+)`/g)) claims.push([match[1], lineAt(source, match.index)]);
  let fenced = false;
  let language = "";
  for (const [index, line] of source.split("\n").entries()) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      language = fenced ? line.slice(3).trim() : "";
    } else if (fenced && fenceLanguages.test(language)) {
      claims.push([line.trim(), index + 1]);
    }
  }
  return claims;
}

test("every documented `seekforge` invocation names a registered command and registered options", () => {
  const { commands, flags, valued } = cliVocabulary();
  assert.ok(commands.size > 50, `expected the CLI to register many commands, found ${commands.size}`);
  assert.ok(flags.size > 50, `expected the CLI to register many options, found ${flags.size}`);
  assert.ok(valued.size > 20, `expected many value-taking options, found ${valued.size}`);

  const unknown = [];
  for (const page of docPages()) {
    for (const [claim, line] of codeClaims(read(page), /^(?:bash|sh|shell|console)?$/)) {
      // Quoted arguments are removed first. A task string is prose that may
      // contain anything, including the words the parser is looking for:
      // `seekforge run "add --force to the CLI"` documents no `--force` option.
      const stripped = claim.replaceAll(/"[^"]*"|'[^']*'/g, " ");
      for (const segment of stripped.split(/\|\||&&|[|;]/)) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        let at = 0;
        while (
          at < tokens.length &&
          (/^[A-Z_][A-Z0-9_]*=/.test(tokens[at]) || ["$", "sudo", "npx"].includes(tokens[at]))
        )
          at++;
        // `seekforge` must be the command word. Without this it matched
        // `pnpm --filter seekforge build`, whose `--filter` belongs to pnpm.
        if (tokens[at] !== "seekforge") continue;
        const rest = tokens.slice(at + 1);
        // Skip past option values, so `--model deepseek-chat` does not offer
        // `deepseek-chat` as the command word.
        let first;
        for (let i = 0; i < rest.length; i += 1) {
          const token = rest[i];
          if (!token.startsWith("-")) {
            first = token;
            break;
          }
          if (valued.has(token.split("=")[0]) && !token.includes("=")) i += 1;
        }
        // Only the first word is checked, never the whole chain: `config set
        // model` ends in an argument, not a third command, and no mechanical
        // rule separates the two.
        if (first && /^[a-z][a-z0-9-]*$/.test(first) && !commands.has(first)) {
          unknown.push(`${page}:${line} — \`seekforge ${first}\` is not a registered command`);
        }
        for (const token of rest) {
          const flag = /^--([a-z][a-z0-9-]*)/.exec(token);
          if (flag && !flags.has(flag[1])) {
            unknown.push(`${page}:${line} — \`--${flag[1]}\` is not a registered option`);
          }
        }
      }
    }
  }
  assert.deepEqual(unknown.sort(), [], "documented command lines that the CLI would reject");
});

// ---------------------------------------------------------------------------
// 2b. A documented TUI slash command must be one the TUI parses.
// ---------------------------------------------------------------------------

/**
 * The single-segment URL paths the HTTP server owns, read out of its dispatch
 * rather than named. `/api` was hard-coded here and `/ws` was not, so the
 * moment a page mentioned the WebSocket upgrade path this check called it an
 * unimplemented TUI command — the same "one instance patched, the class left
 * open" shape the rest of this work is about.
 */
function serverPathRoots() {
  const roots = new Set();
  for (const file of sourceFiles(join(root, "apps", "server", "src"))) {
    if (isTestFile(file.slice(root.length + 1))) continue;
    for (const match of readFileSync(file, "utf8").matchAll(
      /pathname\s*(?:===|!==|\.startsWith\(\s*)\s*"\/([a-z0-9-]+)/g,
    )) {
      roots.add(match[1]);
    }
  }
  return roots;
}

test("every documented `/slash` command and its options exist in the TUI", () => {
  const tui = sourceFiles(join(root, "apps", "tui", "src"))
    .filter((file) => !isTestFile(file.slice(root.length + 1)))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(tui.length > 10000, "could not read the TUI sources");
  const serverPaths = serverPathRoots();
  assert.ok(serverPaths.has("api"), "could not read the server's URL path roots");

  const unknown = [];
  for (const page of docPages()) {
    for (const [claim, line] of codeClaims(read(page), /^(?:text)?$/)) {
      // The command must be a single path-free segment. `/api/loops/:id` and
      // `/private/tmp` also open with a slash and a lowercase word, and they
      // were the only three false positives this check produced; requiring the
      // segment to end at whitespace removes all of them without an ignore list.
      const command = /^\/([a-z][a-z0-9-]*)(?=\s|$)/.exec(claim.trim());
      // A path the server dispatches on is a route, never a TUI command: the
      // automation guide names `/api` as a prefix ("management endpoints are
      // under `/api`") and SERVER-API.md names `/ws` as the upgrade path.
      if (!command || serverPaths.has(command[1])) continue;
      if (!tui.includes(`"/${command[1]}`) && !tui.includes(`"${command[1]}"`)) {
        unknown.push(`${page}:${line} — \`/${command[1]}\` is not a TUI command`);
        continue;
      }
      for (const flag of claim.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!tui.includes(flag[0])) unknown.push(`${page}:${line} — \`/${command[1]} ${flag[0]}\` is not parsed`);
      }
    }
  }
  assert.deepEqual(unknown.sort(), [], "documented TUI commands the TUI does not implement");
});

// ---------------------------------------------------------------------------
// 3. A documented environment variable must be read by the code.
// ---------------------------------------------------------------------------

test("every SEEKFORGE_* variable the docs present as an input is read somewhere", () => {
  const corpus = sourceRoots()
    .flatMap((dir) => sourceFiles(dir))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  // Rust and CI read these names too. The list used to be `crates/` plus
  // `.github/workflows/`, which missed `apps/desktop/src-tauri/src/` — the
  // Tauri shell is Rust living under `apps/`, and it is the only reader of
  // `SEEKFORGE_SERVE_CMD` and `SEEKFORGE_WORKSPACE`. Asking git for the tracked
  // files of each type has no such geography built into it.
  const extra = trackedFiles("*.rs", "*.yml", "*.yaml", "*.toml").map((file) => readFileSync(join(root, file), "utf8"));
  assert.ok(
    extra.some((text) => text.includes("std::env::var")),
    "no Rust source reached the environment-variable corpus",
  );
  const source = `${corpus}\n${extra.join("\n")}`;

  const missing = [];
  for (const page of docPages()) {
    const text = read(page);
    for (const match of text.matchAll(/(.?)\b(SEEKFORGE_[A-Z0-9_]+)\b/g)) {
      // `$SEEKFORGE_TOKEN` in a curl example is the reader's own shell
      // variable, not an input SeekForge reads. Only a bare mention claims the
      // program looks the name up.
      if (match[1] === "$" || match[1] === "{") continue;
      if (source.includes(match[2])) continue;
      missing.push(`${page}:${lineAt(text, match.index)} — ${match[2]}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), [], "documented environment variables nothing reads");
});

// ---------------------------------------------------------------------------
// 3b. A documented config key must be one the code reads.
// ---------------------------------------------------------------------------

test("every config key the configuration guides document is read by the code", () => {
  const source = sourceRoots()
    .flatMap((dir) => sourceFiles(dir))
    .filter((file) => !isTestFile(file.slice(root.length + 1)))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  // Together with checks 2 and 3 this closes the triad the GitLab CI adapter
  // fell through: it had no flag, no config key and no environment variable
  // that could reach it. `surface-drift.test.mjs` walks config key -> guide;
  // this walks the guide back, so a documented knob nothing reads also fails.
  const missing = [];
  for (const page of ["docs/configuration.md", "docs/configuration.zh-CN.md"]) {
    const text = read(page);
    // Only `### \`key\`` headings count. Keys named mid-prose are frequently the
    // fields of an MCP server entry or a hook payload, not config keys.
    const headings = [...text.matchAll(/^#{3,4}\s+`([A-Za-z][A-Za-z0-9.]*)`/gm)];
    assert.ok(headings.length > 20, `${page} documents only ${headings.length} keys — did the heading style change?`);
    for (const heading of headings) {
      const key = heading[1];
      const isRead = new RegExp(`\\b${key}\\??\\s*:`).test(source) || source.includes(`"${key}"`);
      if (!isRead && !source.includes(`.${key}`)) missing.push(`${page}:${lineAt(text, heading.index)} — ${key}`);
    }
  }
  assert.deepEqual(missing.sort(), [], "documented config keys no surface reads");
});

// ---------------------------------------------------------------------------
// 4. A documented import must be a real package export.
// ---------------------------------------------------------------------------

test("every @seekforge/* import in the documentation resolves to a real export", () => {
  // Every workspace package with an entry point, not the three that happened
  // to be importable when this was written. A fourth would otherwise have had
  // its documented imports reported as "not a workspace package".
  const surfaces = {};
  for (const pkg of workspacePackages()) {
    const entry = join(pkg.dir, "src", "index.ts");
    if (!pkg.name?.startsWith("@seekforge/") || !existsSync(entry)) continue;
    surfaces[pkg.name] = packageSurface(entry);
  }
  assert.ok(Object.keys(surfaces).length >= 3, `expected several importable packages, found ${Object.keys(surfaces)}`);
  for (const name of ["@seekforge/core", "@seekforge/shared", "@seekforge/eval-harness"]) {
    assert.ok(surfaces[name]?.size > 50, `expected ${name} to export many symbols, found ${surfaces[name]?.size ?? 0}`);
  }

  const broken = [];
  for (const page of docPages()) {
    const text = read(page);
    for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(@seekforge\/[a-z-]+)[^"]*"/g)) {
      const surface = surfaces[match[2]];
      const where = `${page}:${lineAt(text, match.index)}`;
      if (!surface) {
        broken.push(`${where} — imports from ${match[2]}, which is not a workspace package`);
        continue;
      }
      for (const part of match[1].split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name && !surface.has(name)) broken.push(`${where} — ${match[2]} does not export ${name}`);
      }
    }
  }
  assert.deepEqual(broken.sort(), [], "documented imports that would not compile");
});

// What this file cannot see, so nobody mistakes green here for coverage:
//
//   - A behavior described in prose with no symbol, flag or route to anchor it.
//     "The provider falls back to a text protocol" names nothing checkable; the
//     gate needs a token that either resolves or does not.
//   - A budget, limit or policy that is documented as enforced but enforces
//     nothing. The knob is read, so every check here is satisfied; only a test
//     of the behavior can tell whether reading it changes anything.
//   - Two union types that contradict each other across a boundary. Both halves
//     are live and consumed; the defect is in the disagreement, which needs a
//     type-level comparison, not a reachability walk.
//   - A symbol kept alive only by a dead caller. Reachability here is one hop:
//     `AgentRunner` counts as used because `createDockerRunner` returns it,
//     even when nothing calls `createDockerRunner`. A transitive walk was
//     rejected because the same walk in reverse (core export -> consumer)
//     produced 130 results, almost all of them core calling itself.
//   - Anything claimed only in `docs/boundary-checklist.md` or `docs/roadmap.md`,
//     which are excluded above for the reasons given there.
//   - Dead code the documentation never names. A sweep for exported symbols
//     with no non-test use finds 55 of them repo-wide today, including
//     `createSshRunner`, `startTriggerRun` and four `*ForTests` hooks. That list
//     is real but it is not this gate's question, and shipping it would mean
//     maintaining 55 exemptions, which is how a gate becomes decoration.
//
// Measured honestly against the three incidents that motivated the file: the
// gate reproduces their shape but would only have caught them if the doc had
// named the symbol or the flag. The GitLab CI page said "`glab` adapters" and
// named no selector; the evidence page promised a "Core verification tool" and
// named no function. Both are prose claims. Check 1 catches the same defect the
// moment a page names `createGitLabCiProvider` or `verifyLoopEvidenceIntegrity`,
// and check 2 catches it the moment a page names `--ci-provider` — which is
// what those pages say today, and what a page describing a new capability
// almost always ends up saying.
