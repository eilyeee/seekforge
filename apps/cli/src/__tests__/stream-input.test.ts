// Tests for the stream-json INPUT parser (readStreamJsonInput).
//
// This package has no vitest infra (vitest is not resolvable from apps/cli),
// so — matching src/__tests__/helpers.test.ts — this is a dependency-free
// runner using node:assert, executed via `tsx`. Each case asserts and a
// non-zero exit on the first failure is the signal for the test runner.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readStreamJsonInput } from "../stream-input.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

/** Turn explicit chunks into a readable stream (preserves chunk boundaries). */
function streamOf(chunks: string[]): NodeJS.ReadableStream {
  return Readable.from(chunks);
}

/** Drain the parser into an array of yielded turn texts. */
async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const text of readStreamJsonInput(streamOf(chunks))) out.push(text);
  return out;
}

// --- valid shapes -----------------------------------------------------------

await test("SDK form: text content blocks are concatenated", async () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "hello " },
        { type: "image", source: "ignore-me" },
        { type: "text", text: "world" },
      ],
    },
  });
  assert.deepEqual(await collect([line + "\n"]), ["hello world"]);
});

await test("content-as-string form", async () => {
  const line = JSON.stringify({ type: "user", message: { content: "hello" } });
  assert.deepEqual(await collect([line + "\n"]), ["hello"]);
});

await test("simple form: top-level text", async () => {
  const line = JSON.stringify({ type: "user", text: "hello" });
  assert.deepEqual(await collect([line + "\n"]), ["hello"]);
});

// --- multiple turns ---------------------------------------------------------

await test("multiple user turns in one stream", async () => {
  const input =
    JSON.stringify({ type: "user", text: "one" }) +
    "\n" +
    JSON.stringify({ type: "user", message: { content: "two" } }) +
    "\n" +
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "three" }] },
    }) +
    "\n";
  assert.deepEqual(await collect([input]), ["one", "two", "three"]);
});

// --- ignored envelopes & blank lines ----------------------------------------

await test("non-user envelopes are ignored", async () => {
  const input =
    JSON.stringify({ type: "system", subtype: "init" }) +
    "\n" +
    JSON.stringify({ type: "assistant", message: { content: "hi" } }) +
    "\n" +
    JSON.stringify({ type: "user", text: "keep" }) +
    "\n" +
    JSON.stringify({ type: "result", subtype: "success" }) +
    "\n";
  assert.deepEqual(await collect([input]), ["keep"]);
});

await test("blank and whitespace-only lines are skipped", async () => {
  const input =
    "\n   \n\t\n" +
    JSON.stringify({ type: "user", text: "a" }) +
    "\n\n" +
    JSON.stringify({ type: "user", text: "b" }) +
    "\n   \n";
  assert.deepEqual(await collect([input]), ["a", "b"]);
});

// --- chunk-boundary splitting -----------------------------------------------

await test("chunk boundaries do not change output", async () => {
  const input =
    JSON.stringify({ type: "user", text: "alpha" }) +
    "\n" +
    JSON.stringify({ type: "user", message: { content: "beta" } }) +
    "\n" +
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "gamma" }] },
    }) +
    "\n";
  const expected = ["alpha", "beta", "gamma"];

  // Whole input as one chunk.
  assert.deepEqual(await collect([input]), expected);

  // Split into arbitrary chunks (mid-object, mid-newline).
  const cuts = [0, 5, 13, 27, 40, input.length - 1];
  const chunks: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    if (c <= prev) continue;
    chunks.push(input.slice(prev, c));
    prev = c;
  }
  chunks.push(input.slice(prev));
  assert.deepEqual(await collect(chunks), expected);

  // One character per chunk — the most adversarial boundary case.
  assert.deepEqual(await collect([...input]), expected);
});

await test("final line without trailing newline is parsed", async () => {
  const input = JSON.stringify({ type: "user", text: "no-newline" });
  assert.deepEqual(await collect([input]), ["no-newline"]);
});

// --- error cases ------------------------------------------------------------

await test("malformed JSON throws with 1-based line number", async () => {
  const input =
    JSON.stringify({ type: "user", text: "ok" }) + "\n" + "{not valid json\n";
  await assert.rejects(collect([input]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /stream-json input: invalid JSON on line 2/);
    return true;
  });
});

await test("user envelope with no extractable text throws", async () => {
  const input = JSON.stringify({ type: "user", message: { role: "user" } }) + "\n";
  await assert.rejects(collect([input]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /no extractable text/);
    assert.match(err.message, /line 1/);
    return true;
  });
});

await test("user envelope with empty text content throws", async () => {
  const input =
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "image", source: "x" }] },
    }) + "\n";
  await assert.rejects(collect([input]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /no extractable text/);
    return true;
  });
});

console.log(`${passed} stream-input tests passed`);
