import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTooLargeError, readFileBounded } from "../src/bounded-file-read.js";
import { MAX_CONFIG_FILE_BYTES, readJsonConfigLayer } from "../src/config-layers.js";
import { addTodo, loadTodos, MAX_TODO_FILE_BYTES } from "../src/todos.js";
import { makeTempDir } from "./helpers.js";

describe("bounded structured state", () => {
  it("rejects an oversized exact file without buffering it", () => {
    const workspace = makeTempDir();
    const file = join(workspace, "oversized.json");
    writeFileSync(file, Buffer.alloc(1025));
    expect(() => readFileBounded(file, 1024)).toThrow(FileTooLargeError);
  });

  it("rejects a FIFO without waiting for a writer", () => {
    if (process.platform === "win32") return;
    const workspace = makeTempDir();
    const file = join(workspace, "state.pipe");
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    const delayedWriter = spawn("sh", ["-c", 'sleep 2; printf x > "$1"', "sh", file], { stdio: "ignore" });
    const started = Date.now();
    try {
      expect(() => readFileBounded(file, 1024)).toThrow(/regular file/);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      delayedWriter.kill("SIGKILL");
    }
  });

  it("ignores an oversized config layer", () => {
    const workspace = makeTempDir();
    const file = join(workspace, "config.json");
    writeFileSync(file, Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1, 0x20));
    expect(readJsonConfigLayer(file, { requireObject: true })).toEqual({});
  });

  it("does not overwrite an oversized todo file during mutation", () => {
    const workspace = makeTempDir();
    const stateDir = join(workspace, ".seekforge");
    const file = join(stateDir, "todos.md");
    mkdirSync(stateDir);
    writeFileSync(file, Buffer.alloc(MAX_TODO_FILE_BYTES + 1, 0x61));

    expect(loadTodos(workspace)).toEqual([]);
    expect(() => addTodo(workspace, "must not replace state")).toThrow(FileTooLargeError);
    expect(readFileSync(file).length).toBe(MAX_TODO_FILE_BYTES + 1);
  });
});
