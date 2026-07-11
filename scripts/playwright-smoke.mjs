#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const temp = mkdtempSync(join(tmpdir(), "seekforge-playwright-smoke-"));
const page = join(temp, "index.html");
const screenshot = join(temp, "smoke.png");

try {
  writeFileSync(page, "<!doctype html><title>SeekForge Playwright smoke</title><h1>ready</h1>");
  const result = spawnSync(
    "pnpm",
    ["dlx", "playwright@1.55.0", "screenshot", "--browser", "chromium", pathToFileURL(page).href, screenshot],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`Playwright smoke exited with ${result.status ?? "no status"}`);
  }
  console.log("Playwright Chromium smoke passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
