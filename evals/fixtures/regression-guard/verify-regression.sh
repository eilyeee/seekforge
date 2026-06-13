#!/bin/sh
# Anti-cheat for the regression-guard task: proves the agent's test suite
# actually FAILS against the original buggy implementation (i.e. a real
# regression test was added, not just a tautological one).
#
# It builds a throwaway copy of the project with the KNOWN-BUGGY titlecase.js
# but the agent's CURRENT test/ directory, then runs the suite and asserts a
# NON-zero exit. The fixture's own files are never modified.
set -e

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/src" "$work/test"
cp -R test/. "$work/test/"
cp package.json "$work/package.json"

cat > "$work/src/titlecase.js" <<'EOF'
"use strict";
function titleCase(sentence) {
  return sentence
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}
module.exports = { titleCase };
EOF

if (cd "$work" && node --test >/dev/null 2>&1); then
  echo "FAIL: the test suite still passes against the buggy implementation;" >&2
  echo "no effective regression test was added." >&2
  exit 1
fi

echo "OK: a regression test fails on the buggy implementation."
