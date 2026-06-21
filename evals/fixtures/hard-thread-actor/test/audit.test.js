"use strict";

const test = require("node:test");
const { beforeEach } = require("node:test");
const assert = require("node:assert");
const { createTask, completeTask, reopenTask, deleteTask, getLog, clearLog, reset } = require("../src/index.js");

beforeEach(() => {
  clearLog();
  reset();
});

test("create records the acting user", () => {
  createTask("Write docs", "alice");
  assert.deepStrictEqual(getLog(), [{ action: "create", taskId: 1, actor: "alice" }]);
});

test("complete and reopen record their actor", () => {
  const t = createTask("X", "alice");
  completeTask(t.id, "bob");
  reopenTask(t.id, "cara");
  assert.deepStrictEqual(getLog(), [
    { action: "create", taskId: 1, actor: "alice" },
    { action: "complete", taskId: 1, actor: "bob" },
    { action: "reopen", taskId: 1, actor: "cara" },
  ]);
});

test("delete records the actor", () => {
  const t = createTask("X", "alice");
  deleteTask(t.id, "dan");
  assert.deepStrictEqual(getLog(), [
    { action: "create", taskId: 1, actor: "alice" },
    { action: "delete", taskId: 1, actor: "dan" },
  ]);
});

test("a mixed sequence tags each entry with the right actor in order", () => {
  const a = createTask("A", "alice");
  const b = createTask("B", "bob");
  completeTask(a.id, "cara");
  deleteTask(b.id, "alice");
  assert.deepStrictEqual(getLog(), [
    { action: "create", taskId: 1, actor: "alice" },
    { action: "create", taskId: 2, actor: "bob" },
    { action: "complete", taskId: 1, actor: "cara" },
    { action: "delete", taskId: 2, actor: "alice" },
  ]);
});

test("task state still behaves correctly (regression)", () => {
  const t = createTask("X", "alice");
  assert.strictEqual(t.status, "open");
  const done = completeTask(t.id, "bob");
  assert.strictEqual(done.status, "done");
  const open = reopenTask(t.id, "cara");
  assert.strictEqual(open.status, "open");
});
