"use strict";
const { getUser } = require("./store");
function profileLine(id) {
  const u = getUser(id);
  return u ? `${u.name} <${u.email}>` : "unknown";
}
module.exports = { profileLine };
