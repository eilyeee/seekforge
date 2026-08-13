// `seekforge mcp login <name>` runs OAuth discovery against the server's `url`,
// registers a client and opens a browser at whatever authorization page that
// server names. A repository layer can no longer repoint a name the user owns,
// but a name only the checkout defines still supplies that url — so in a clone
// nobody has vouched for, the user picks the name and the repository picks
// where it sends them. `mcp list` gained the folder-access gate for the same
// reason; this pins that `login` did too.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { mcpLoginCommand } from "../commands/mcp-login.js";

/**
 * Run `mcp login probe` in a scratch project whose config declares one remote
 * server, with HOME isolated so the folder-authorization store starts empty and
 * stdin closed so an unauthorized folder cannot block on a prompt.
 */
async function runLogin(where: "project" | "global"): Promise<{ out: string[]; err: string[]; reached: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "sf-mcp-login-home-"));
  const project = mkdtempSync(join(tmpdir(), "sf-mcp-login-repo-"));
  const base = where === "global" ? join(home, ".seekforge") : join(project, ".seekforge");
  mkdirSync(base, { recursive: true });
  // 127.0.0.1:1 refuses instantly, so "did discovery run" is observable without
  // this test ever reaching the network.
  writeFileSync(
    join(base, "config.json"),
    JSON.stringify({ mcpServers: { probe: { url: "http://127.0.0.1:1/mcp" } } }),
  );

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
    await mcpLoginCommand("probe", {});
  } catch {
    // Discovery against a closed port rejects; that it got that far is the
    // signal, and the assertions below read it from the captured output.
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
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  // Discovery is the first thing past the gate, and against a closed port it
  // fails with this hint. Matching the url instead would match the gate's own
  // notice, which prints the url on purpose.
  const text = [...out, ...err].join("\n");
  return { out, err, reached: text.includes("/.well-known/") };
}

test("mcp login names the repository as the source before authorizing against its url", async () => {
  const { out } = await runLogin("project");
  const text = out.join("\n");
  assert.match(text, /defined by this repository/);
  assert.match(text, /127\.0\.0\.1:1/, "the url the checkout chose must be shown, not just the name");
});

test("mcp login does not authorize a repository-defined server in an unvouched-for folder", async () => {
  const { reached } = await runLogin("project");
  assert.equal(reached, false, "discovery ran against a url the repository chose without folder consent");
});

test("mcp login needs no folder consent for the user's own server", async () => {
  const { out } = await runLogin("global");
  assert.doesNotMatch(out.join("\n"), /defined by this repository/);
});
