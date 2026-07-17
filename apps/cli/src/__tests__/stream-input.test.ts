// Tests for the stream-json INPUT parser (readStreamJsonInput).

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "vitest";
import { readStreamJsonInput } from "../stream-input.js";

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

test("SDK form: text content blocks are concatenated", async () => {
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

test("content-as-string form", async () => {
  const line = JSON.stringify({ type: "user", message: { content: "hello" } });
  assert.deepEqual(await collect([line + "\n"]), ["hello"]);
});

test("simple form: top-level text", async () => {
  const line = JSON.stringify({ type: "user", text: "hello" });
  assert.deepEqual(await collect([line + "\n"]), ["hello"]);
});

// --- multiple turns ---------------------------------------------------------

test("multiple user turns in one stream", async () => {
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

test("non-user envelopes are ignored", async () => {
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

test("blank and whitespace-only lines are skipped", async () => {
  const input =
    "\n   \n\t\n" +
    JSON.stringify({ type: "user", text: "a" }) +
    "\n\n" +
    JSON.stringify({ type: "user", text: "b" }) +
    "\n   \n";
  assert.deepEqual(await collect([input]), ["a", "b"]);
});

// --- chunk-boundary splitting -----------------------------------------------

test("chunk boundaries do not change output", async () => {
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

test("final line without trailing newline is parsed", async () => {
  const input = JSON.stringify({ type: "user", text: "no-newline" });
  assert.deepEqual(await collect([input]), ["no-newline"]);
});

// --- error cases ------------------------------------------------------------

test("malformed JSON throws with 1-based line number", async () => {
  const input = JSON.stringify({ type: "user", text: "ok" }) + "\n" + "{not valid json\n";
  await assert.rejects(collect([input]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /stream-json input: invalid JSON on line 2/);
    return true;
  });
});

test("user envelope with no content is skipped, not an error", async () => {
  const input = JSON.stringify({ type: "user", message: { role: "user" } }) + "\n";
  assert.deepEqual(await collect([input]), []);
});

test("structured user turn with only non-text blocks (tool_result/image) is skipped", async () => {
  // A replayed transcript legitimately carries user turns whose content is a
  // tool_result or image — skip them rather than aborting the whole run.
  const input =
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
    }) +
    "\n" +
    JSON.stringify({ type: "user", text: "after the tool result" }) +
    "\n";
  assert.deepEqual(await collect([input]), ["after the tool result"]);
});

test("an EXPLICIT empty-text simple form is still an error", async () => {
  const input = JSON.stringify({ type: "user", text: "" }) + "\n";
  await assert.rejects(collect([input]), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /no extractable text/);
    return true;
  });
});
