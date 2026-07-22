import assert from "node:assert/strict";
import test from "node:test";
import { parseRustHost, sidecarOutputName } from "./build-sidecar.mjs";

test("parses rustc host output", () => {
  assert.equal(parseRustHost("rustc 1.90.0\nhost: aarch64-apple-darwin\nrelease: 1.90.0\n"), "aarch64-apple-darwin");
  assert.throws(() => parseRustHost("rustc 1.90.0\n"), /host target/);
});

test("uses Tauri's target-qualified executable name on every platform", () => {
  assert.equal(sidecarOutputName("aarch64-apple-darwin"), "seekforge-server-aarch64-apple-darwin");
  assert.equal(sidecarOutputName("x86_64-unknown-linux-gnu"), "seekforge-server-x86_64-unknown-linux-gnu");
  assert.equal(sidecarOutputName("x86_64-pc-windows-msvc"), "seekforge-server-x86_64-pc-windows-msvc.exe");
});
