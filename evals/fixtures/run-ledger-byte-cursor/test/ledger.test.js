import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEventPage } from "../src/ledger.js";

test("resumes after multibyte event text", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cursor-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(
      path,
      [
        JSON.stringify({ seq: 1, message: "修复游标" }),
        JSON.stringify({ seq: 2, message: "second" }),
        JSON.stringify({ seq: 3, message: "third" }),
        "",
      ].join("\n"),
    );
    const first = readEventPage(path, 0, 1);
    const second = readEventPage(path, first.byteOffset, 1);
    assert.deepEqual(first.events.map((event) => event.seq), [1]);
    assert.deepEqual(second.events.map((event) => event.seq), [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
