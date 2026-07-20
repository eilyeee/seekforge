import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSensitiveBasename } from "../src/index.js";

// packages/shared had no tests at all, yet it hosts isSensitiveBasename — the
// list that decides which file contents are withheld from the model and that
// must stay in lockstep with the Rust is_sensitive_basename mirror. This suite
// covers the behavior directly and asserts the shared TS<->Rust fixture (the
// Rust side asserts the same file).
const fixtureUrl = new URL("../../../test-fixtures/sensitive-basename.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as {
  cases: Array<{ name: string; sensitive: boolean }>;
};

describe("isSensitiveBasename", () => {
  it("matches the shared TS<->Rust parity fixture", () => {
    for (const { name, sensitive } of fixture.cases) {
      expect(isSensitiveBasename(name), name).toBe(sensitive);
    }
  });

  it("is case-sensitive and anchored (no substring false positives)", () => {
    expect(isSensitiveBasename(".env")).toBe(true);
    expect(isSensitiveBasename("my.env")).toBe(false); // .env only at the start
    expect(isSensitiveBasename("keys.pem.bak")).toBe(false); // .pem only at the end
    expect(isSensitiveBasename("PRIVATE.KEY")).toBe(false); // case-sensitive
  });
});
