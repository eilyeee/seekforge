"use strict";
const { getUser } = require("./store");
function names(ids) {
  return ids.map((id) => {
    const u = getUser(id);
    return u ? u.name : null;
  });
}
module.exports = { names };
