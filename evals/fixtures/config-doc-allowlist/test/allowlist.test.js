import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("README does not advertise config-set keys absent from the CLI allowlist", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const config = readFileSync(new URL("../apps/cli/src/config.ts", import.meta.url), "utf8");
  const advertised = /config set (\S+)/.exec(readme)?.[1]?.split("|") ?? [];
  for (const key of advertised) {
    assert.match(config, new RegExp(`['\"]${key.trim()}['\"]`), `README advertises unsupported key ${key}`);
  }
});
