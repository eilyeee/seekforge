"use strict";
const USERS = [
  { id: 1, name: "Alice", email: "alice@x.com", role: "admin" },
  { id: 2, name: "Bob", email: "bob@x.com", role: "member" },
  { id: 3, name: "Cara", email: "cara@x.com", role: "member" },
];
function getUser(id) {
  return USERS.find((u) => u.id === id) || null;
}
module.exports = { USERS, getUser };
