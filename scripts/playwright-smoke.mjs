#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "seekforge-playwright-smoke-"));
const screenshot = join(temp, "desktop.png");
let preview;

try {
  const build = spawnSync("pnpm", ["--filter", "@seekforge/desktop", "build"], {
    cwd: repo,
    env: { ...process.env, VITE_MOCK: "1" },
    stdio: "inherit",
    timeout: 5 * 60 * 1000,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Desktop build exited with ${build.status ?? "no status"}`);

  preview = spawn(`${repo}/apps/desktop/node_modules/.bin/vite`, ["preview", "--host", "127.0.0.1", "--port", "0"], {
    cwd: `${repo}/apps/desktop`,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let previewOutput = "";
  let previewUrl = "";
  let previewError;
  const urlRe = /http:\/\/127\.0\.0\.1:\d+\/?/;
  const capture = (chunk) => {
    previewOutput = `${previewOutput}${chunk.toString()}`.slice(-8192);
    previewUrl = previewUrl || urlRe.exec(previewOutput)?.[0] || "";
    process.stderr.write(`[desktop] ${chunk}`);
  };
  preview.stdout.on("data", capture);
  preview.stderr.on("data", capture);
  preview.on("error", (error) => {
    previewError = error;
  });

  for (let i = 0; i < 150 && !previewUrl && !previewError && preview.exitCode === null; i++) await sleep(200);
  if (previewError) throw previewError;
  if (!previewUrl) throw new Error(`Desktop preview did not start within 30s\n${previewOutput}`);

  const result = spawnSync(
    "pnpm",
    [
      "dlx",
      "playwright@1.55.0",
      "screenshot",
      "--browser",
      "chromium",
      "--timeout",
      "30000",
      "--wait-for-selector",
      "#root > *",
      "--wait-for-timeout",
      "1500",
      previewUrl,
      screenshot,
    ],
    { cwd: repo, stdio: "inherit", timeout: 2 * 60 * 1000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Playwright smoke exited with ${result.status ?? "no status"}`);
  if (!existsSync(screenshot) || statSync(screenshot).size < 10_000) {
    throw new Error("Playwright did not produce a non-empty Desktop screenshot");
  }
  console.log(`Desktop Playwright smoke passed (${statSync(screenshot).size} bytes)`);
} finally {
  if (preview && preview.exitCode === null && preview.signalCode === null) {
    preview.kill("SIGTERM");
    await Promise.race([once(preview, "exit"), sleep(2_000)]);
  }
  if (preview && preview.exitCode === null && preview.signalCode === null) {
    preview.kill("SIGKILL");
    await Promise.race([once(preview, "exit"), sleep(2_000)]);
  }
  rmSync(temp, { recursive: true, force: true });
}
