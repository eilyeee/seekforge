"use strict";

// `dedupe` should remove duplicate values while preserving first-seen order.
// It currently returns the input untouched, so the suite is RED. A real fix
// changes the implementation; a no-op "fix" leaves verify output identical
// run after run — the loop's no-progress guardrail (auto-loop.ts) is what
// stops that, and verify-no-progress.sh below proves an effective change.
function dedupe(items) {
  return items;
}

module.exports = { dedupe };
