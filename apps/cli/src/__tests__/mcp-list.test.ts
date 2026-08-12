// `seekforge mcp list` does not read a list — it STARTS every entry on it.
// `mcp add` writes to the project's `.seekforge/config.json` by default, so
// those entries are ordinarily the user's own; in a repository nobody has
// vouched for, they are whatever the clone committed. Before the folder-access
// gate, `seekforge mcp` (list is the default subcommand) executed them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { mcpListCommand } from "../commands/mcp.js";

type Capture = { out: string[]; err: string[]; marker: string; project: string };

/**
 * Run `mcp list` in a scratch project whose config declares one stdio server
 * that touches a marker file, with HOME isolated so the folder-authorization
 * store starts empty.
 */
async function runList(
  where: "project" | "global",
  opts: { yes?: boolean } = {},
): Promise<Capture & { authorized: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "sf-mcp-list-home-"));
  const project = mkdtempSync(join(tmpdir(), "sf-mcp-list-repo-"));
  const marker = join(project, "SPAWNED");
  const servers = { probe: { command: "sh", args: ["-c", `touch ${marker}`] } };
  const base = where === "global" ? join(home, ".seekforge") : join(project, ".seekforge");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "config.json"), JSON.stringify({ mcpServers: servers }));

  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  const previousCwd = process.cwd();
  const previousExit = process.exitCode;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  process.chdir(project);
  try {
    await mcpListCommand(opts);
  } finally {
    process.chdir(previousCwd);
    console.log = realLog;
    console.error = realError;
    process.stderr.write = realErrWrite;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousProfile;
    process.exitCode = previousExit;
  }
  const authorized = existsSync(join(home, ".seekforge", "authorized.json"));
  const capture = { out, err, marker, project, authorized };
  return capture;
}

test("mcp list does not spawn a repository-supplied server in an unvouched-for folder", async () => {
  const { marker, err, project } = await runList("project");
  assert.equal(existsSync(marker), false, "a cloned repository's command must not run without folder consent");
  assert.ok(
    err.join("\n").toLowerCase().includes("authoriz"),
    `expected an authorization refusal, got: ${err.join("\n")}`,
  );
  rmSync(project, { recursive: true, force: true });
});

test("mcp list still starts repository servers once the folder is authorized", async () => {
  const { marker, project } = await runList("project", { yes: true });
  assert.equal(existsSync(marker), true, "-y must keep the documented listing behavior working");
  rmSync(project, { recursive: true, force: true });
});

test("mcp list needs no folder consent for the user's own servers", async () => {
  const { marker, project, authorized } = await runList("global");
  assert.equal(existsSync(marker), true, "a server from ~/.seekforge is the user's own; no folder gate applies");
  assert.equal(authorized, false, "listing a user-owned server must not silently authorize the folder");
  rmSync(project, { recursive: true, force: true });
});
