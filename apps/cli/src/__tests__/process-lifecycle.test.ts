import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { waitForStdinEnd } from "../commands/mcp-serve.js";
import { runInheritedCommand } from "../inherited-command.js";

test("MCP stdio wait rejects input errors and removes lifecycle listeners", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const waiting = waitForStdinEnd(input);
  input.destroy(new Error("stdin failed"));
  await assert.rejects(waiting, /stdin failed/);
  for (const event of ["end", "close", "error"]) assert.equal(input.listenerCount(event), 0);
});

test("inherited command reports the child exit status", async () => {
  assert.equal(await runInheritedCommand(process.execPath, ["-e", "process.exit(7)"]), 7);
});
