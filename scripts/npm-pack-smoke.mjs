#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(new URL("..", import.meta.url).pathname);
const cliDir = join(repo, "apps", "cli");
const temp = mkdtempSync(join(tmpdir(), "seekforge-pack-smoke-"));
const prefix = join(temp, "install");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
  }
  return result.stdout?.trim() ?? "";
}

try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
      cwd: cliDir,
      capture: true,
    }),
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball");

  run("npm", ["install", "--global", "--prefix", prefix, join(temp, filename)]);

  const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
  const suffix = process.platform === "win32" ? ".cmd" : "";
  run(join(binDir, `seekforge${suffix}`), ["--help"]);
  run(join(binDir, `seekforge-tui${suffix}`), ["--help"]);
  console.log(`npm package smoke passed on Node ${process.version}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
