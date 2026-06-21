"use strict";
const { getUser } = require("./store");
function canEdit(id) {
  const u = getUser(id);
  return !!u && u.role === "admin";
}
module.exports = { canEdit };
