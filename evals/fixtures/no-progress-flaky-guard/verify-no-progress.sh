#!/bin/sh
# Anti-no-op guard for the no-progress task: proves the agent actually CHANGED
# the implementation (made progress) rather than leaving src/dedupe.js as the
# original identity stub.
#
# It runs the agent's CURRENT test/ against the ORIGINAL no-op dedupe.js in a
# throwaway copy and asserts the suite FAILS there. If the suite still passes
# against the no-op stub, the test is tautological / no real change was made —
# the same "identical verify output, no progress" condition the auto-loop's
# no_progress guardrail trips on. The fixture's own files are never modified.
set -e

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/src" "$work/test"
cp -R test/. "$work/test/"
cp package.json "$work/package.json"

cat > "$work/src/dedupe.js" <<'EOF'
"use strict";
function dedupe(items) {
  return items;
}
module.exports = { dedupe };
EOF

if (cd "$work" && node --test >/dev/null 2>&1); then
  echo "FAIL: the suite still passes against the original no-op dedupe;" >&2
  echo "no real progress was made (no-progress condition)." >&2
  exit 1
fi

echo "OK: real progress was made (the suite fails on the no-op stub)."
