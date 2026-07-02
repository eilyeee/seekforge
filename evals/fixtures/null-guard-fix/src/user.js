"use strict";

/**
 * displayName(user) -> a printable name for the UI.
 *
 * Spec: return the user's non-empty `name`; otherwise fall back to
 * "Anonymous" when `user` is null/undefined or its `name` is missing or an
 * empty string.
 *
 * BUG: it dereferences `user.name` unconditionally, so a null/undefined user
 * throws a TypeError and a missing/empty name leaks through. Add the guards.
 */
function displayName(user) {
  return user.name;
}

module.exports = { displayName };
