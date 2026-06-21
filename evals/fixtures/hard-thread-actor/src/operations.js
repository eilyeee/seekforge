"use strict";
// Public operations.
const service = require("./service");
function createTask(title) { return service.create(title); }
function completeTask(id) { return service.complete(id); }
function reopenTask(id) { return service.reopen(id); }
function deleteTask(id) { return service.destroy(id); }
module.exports = { createTask, completeTask, reopenTask, deleteTask };
