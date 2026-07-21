import assert from "node:assert/strict";
import test from "node:test";

import { isValidSemver, replaceJsonVersion } from "./release.mjs";

test("release semver validation rejects ambiguous versions", () => {
  for (const version of ["0.7.0", "1.2.3-alpha.1", "1.2.3+build.5"]) {
    assert.equal(isValidSemver(version), true, version);
  }
  for (const version of ["01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2", "v1.2.3"]) {
    assert.equal(isValidSemver(version), false, version);
  }
});

test("JSON version replacement updates only the top-level field", () => {
  const input = '{\n  "nested": { "version": "wrong" },\n  "version": "0.7.0"\n}\n';
  const output = replaceJsonVersion(input, "0.8.0");
  assert.deepEqual(JSON.parse(output), {
    nested: { version: "wrong" },
    version: "0.8.0",
  });
  assert.equal(output.endsWith("\n"), true);
});

test("JSON version replacement rejects non-object and missing versions", () => {
  assert.throws(() => replaceJsonVersion("[]\n", "1.0.0"), /JSON object/);
  assert.throws(() => replaceJsonVersion('{"name":"x"}\n', "1.0.0"), /string "version"/);
});
