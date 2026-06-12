// Tests for the output-style presets. The CLI has no vitest infra (vitest is
// not resolvable from apps/cli), so — matching src/__tests__/helpers.test.ts —
// this is a dependency-free runner (run via `tsx`): each case asserts with
// node:assert and a non-zero exit on the first failure signals `pnpm test`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTPUT_STYLES,
  isOutputStyle,
  outputStylePrompt,
  resolveOutputStyle,
  type OutputStyle,
} from "../output-style.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

// --- OUTPUT_STYLES contents and order ---------------------------------------
test("OUTPUT_STYLES is the four styles in canonical order", () => {
  assert.deepEqual([...OUTPUT_STYLES], ["default", "concise", "explanatory", "learning"]);
});

// --- isOutputStyle ----------------------------------------------------------
test("isOutputStyle: true for every known style", () => {
  for (const s of OUTPUT_STYLES) assert.equal(isOutputStyle(s), true);
});
test("isOutputStyle: false for unknowns", () => {
  assert.equal(isOutputStyle("bogus"), false);
  assert.equal(isOutputStyle(""), false);
  assert.equal(isOutputStyle("Default"), false); // case-sensitive
  assert.equal(isOutputStyle("verbose"), false);
});

// --- outputStylePrompt ------------------------------------------------------
test("outputStylePrompt: default returns undefined (no change)", () => {
  assert.equal(outputStylePrompt("default"), undefined);
});
test("outputStylePrompt: non-default styles return non-empty strings", () => {
  for (const s of ["concise", "explanatory", "learning"] as const) {
    const out = outputStylePrompt(s);
    assert.equal(typeof out, "string");
    assert.ok((out as string).trim().length > 0, `${s} addendum should be non-empty`);
  }
});
test("outputStylePrompt: the three addenda are distinct", () => {
  const concise = outputStylePrompt("concise");
  const explanatory = outputStylePrompt("explanatory");
  const learning = outputStylePrompt("learning");
  assert.notEqual(concise, explanatory);
  assert.notEqual(concise, learning);
  assert.notEqual(explanatory, learning);
});
test("outputStylePrompt: unknown style throws", () => {
  assert.throws(() => outputStylePrompt("bogus"));
  assert.throws(() => outputStylePrompt(""));
});
// Guard the *intent* of each preset so it can't be silently weakened into a
// no-op (the round-19 dogfood found the original wording too soft to change
// model output). Each style must carry its defining directive.
test("outputStylePrompt: presets carry their defining directive", () => {
  const concise = outputStylePrompt("concise") as string;
  const explanatory = outputStylePrompt("explanatory") as string;
  const learning = outputStylePrompt("learning") as string;
  assert.match(concise, /terse|one[- ]line|shortest|concise/i);
  assert.match(explanatory, /why|reasoning|trade-?off|explain/i);
  assert.match(learning, /TODO\(human\)/);
});

// --- resolveOutputStyle: built-ins + custom files ---------------------------
test("resolveOutputStyle: built-in styles resolve to their preset", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sf-style-"));
  assert.equal(resolveOutputStyle("default", tmp), undefined);
  assert.equal(resolveOutputStyle("concise", tmp), outputStylePrompt("concise"));
  rmSync(tmp, { recursive: true });
});

test("resolveOutputStyle: a custom .seekforge/output-styles/<name>.md is used (frontmatter stripped)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sf-style-"));
  const dir = join(tmp, ".seekforge", "output-styles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pirate.md"), "---\ndescription: Arr\n---\nSpeak like a pirate.");
  assert.equal(resolveOutputStyle("pirate", tmp), "Speak like a pirate.");
  rmSync(tmp, { recursive: true });
});

test("resolveOutputStyle: unknown style with no file throws", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sf-style-"));
  assert.throws(() => resolveOutputStyle("nope", tmp));
  rmSync(tmp, { recursive: true });
});

// Type-level sanity: OUTPUT_STYLES is exactly OutputStyle[] (compile-time only).
const _styleCheck: readonly OutputStyle[] = OUTPUT_STYLES;
void _styleCheck;

console.log(`${passed} output-style tests passed`);
