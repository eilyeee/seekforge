"use strict";
// Low-level task storage. Each mutation writes an audit record.
const { record } = require("./audit");
const _tasks = new Map();
let _nextId = 1;
function insert(title) {
  const id = _nextId++;
  const task = { id, title, status: "open" };
  _tasks.set(id, task);
  record({ action: "create", taskId: id });
  return task;
}
function setStatus(id, status) {
  const task = _tasks.get(id);
  if (!task) throw new Error("no such task: " + id);
  task.status = status;
  record({ action: status === "done" ? "complete" : "reopen", taskId: id });
  return task;
}
function remove(id) {
  if (!_tasks.has(id)) throw new Error("no such task: " + id);
  _tasks.delete(id);
  record({ action: "delete", taskId: id });
}
function reset() { _tasks.clear(); _nextId = 1; }
module.exports = { insert, setStatus, remove, reset };
