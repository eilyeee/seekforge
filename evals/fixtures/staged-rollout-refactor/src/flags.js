"use strict";

/**
 * Feature-flag store. Today a flag is just a boolean: on for everyone or off
 * for everyone.
 *
 * We want STAGED ROLLOUT: a flag is enabled for a deterministic percentage of
 * users (0-100) based on a stable hash of the userId, so the same user always
 * gets the same answer and roughly `percent`% of users see the feature.
 */

const FLAGS = {
  // name -> percentage of users the flag is enabled for (0-100)
  "new-checkout": 100,
  "beta-search": 0,
  "dark-mode": 50,
};

/**
 * Stable, well-distributed hash of a string into [0, 100).
 * (FNV-1a 32-bit, mapped into a percent bucket.)
 */
function bucketOf(userId) {
  let h = 0x811c9dc5;
  const s = String(userId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // h is a 32-bit int (possibly negative); fold to unsigned then to [0,100).
  return (h >>> 0) % 100;
}

/**
 * Whether `flagName` is enabled for `userId`.
 *
 * Contract:
 *  - A flag at 0%   is OFF for every user.
 *  - A flag at 100% is ON  for every user.
 *  - Otherwise it is ON when bucketOf(userId) < percent.
 *  - Unknown flags are OFF.
 */
function isEnabled(flagName, userId) {
  // TODO: currently treats every known flag as boolean-ish: any non-zero
  // percentage is on for everyone, which defeats staged rollout.
  const percent = FLAGS[flagName];
  if (percent === undefined) return false;
  return percent > 0;
}

module.exports = { isEnabled, bucketOf, FLAGS };
