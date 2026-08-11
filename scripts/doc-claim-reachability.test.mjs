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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

/**
 * Pages that make claims about what a user can reach.
 *
 * `boundary-checklist.md` and `roadmap.md` are excluded on purpose and they are
 * the only exclusions. The boundary checklist is an engineering log of bug
 * *classes*: it quotes internal helpers, deleted code and hypothetical snippets
 * (`setsid`, `closeBrowser`, `foo_bar`, `/var`), none of which is a promise to a
 * user — it produced every false positive in the first pass of this file. The
 * roadmap describes work that has not shipped, so naming a symbol there is a
 * plan, not a claim of reachability.
 */
function docPages() {
  const pages = ["README.md", "README.zh-CN.md"];
  for (const name of readdirSync(join(root, "docs"))) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith("boundary-checklist") || name.startsWith("roadmap")) continue;
    pages.push(`docs/${name}`);
  }
  return pages;
}

/** Every source file under `dir`, recursively, skipping build output. */
function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "target") sourceFiles(full, out);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isTestFile = (rel) => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\./.test(rel) || /(^|\/)mock\//.test(rel);

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
  const files = [
    ...sourceFiles(join(root, "apps")),
    ...sourceFiles(join(root, "packages")),
    ...sourceFiles(join(root, "scripts")),
    ...sourceFiles(join(root, "examples")),
  ];
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
  for (const match of source.matchAll(/\.(?:option|requiredOption|addOption)\(\s*[`"']([^`"']+)[`"']/g)) {
    for (const flag of match[1].matchAll(/--([a-z][a-z0-9-]*)/g)) flags.add(flag[1]);
  }
  for (const match of source.matchAll(/new Option\(\s*"([^"]+)"/g)) {
    for (const flag of match[1].matchAll(/--([a-z][a-z0-9-]*)/g)) flags.add(flag[1]);
  }
  return { commands, flags };
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
  const { commands, flags } = cliVocabulary();
  assert.ok(commands.size > 50, `expected the CLI to register many commands, found ${commands.size}`);
  assert.ok(flags.size > 50, `expected the CLI to register many options, found ${flags.size}`);

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
        const first = rest.find((token) => !token.startsWith("-"));
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

test("every documented `/slash` command and its options exist in the TUI", () => {
  const tui = sourceFiles(join(root, "apps", "tui", "src"))
    .filter((file) => !isTestFile(file.slice(root.length + 1)))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.ok(tui.length > 10000, "could not read the TUI sources");

  const unknown = [];
  for (const page of docPages()) {
    for (const [claim, line] of codeClaims(read(page), /^(?:text)?$/)) {
      // The command must be a single path-free segment. `/api/loops/:id` and
      // `/private/tmp` also open with a slash and a lowercase word, and they
      // were the only three false positives this check produced; requiring the
      // segment to end at whitespace removes all of them without an ignore list.
      const command = /^\/([a-z][a-z0-9-]*)(?=\s|$)/.exec(claim.trim());
      // `/api` alone is the REST namespace root, which the automation guide
      // names as a prefix ("management endpoints are under `/api`"). It is a
      // route prefix, never a TUI command.
      if (!command || command[1] === "api") continue;
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
  const corpus = [
    ...sourceFiles(join(root, "apps")),
    ...sourceFiles(join(root, "packages")),
    ...sourceFiles(join(root, "scripts")),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const extra = [];
  for (const dir of [join(root, "crates"), join(root, ".github", "workflows")]) {
    if (!existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "target") stack.push(full);
        } else if (/\.(rs|ya?ml|toml)$/.test(entry.name)) {
          extra.push(readFileSync(full, "utf8"));
        }
      }
    }
  }
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
  const source = [...sourceFiles(join(root, "apps")), ...sourceFiles(join(root, "packages"))]
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
  const surfaces = {
    "@seekforge/core": packageSurface(join(root, "packages", "core", "src", "index.ts")),
    "@seekforge/shared": packageSurface(join(root, "packages", "shared", "src", "index.ts")),
    "@seekforge/eval-harness": packageSurface(join(root, "packages", "eval-harness", "src", "index.ts")),
  };
  for (const [name, surface] of Object.entries(surfaces)) {
    assert.ok(surface.size > 50, `expected ${name} to export many symbols, found ${surface.size}`);
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
