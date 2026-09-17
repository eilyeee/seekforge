// `seekforge mcp list` does not read a list — it STARTS every entry it lists.
// `mcp add` writes to the project's `.seekforge/config.json` by default, so
// those entries are ordinarily the user's own; in a repository nobody has
// vouched for, they are whatever the clone committed. A repository entry is
// therefore started only once the user approved that exact definition for the
// workspace, and even then only behind the folder-access gate.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { approveProjectMcpServer, rejectProjectMcpServer } from "@seekforge/core";
import { mcpListCommand } from "../commands/mcp.js";

type Capture = { out: string[]; err: string[]; marker: string; project: string };

type Decision = "approve" | "reject" | "edit-after-approve";

/**
 * Run `mcp list` in a scratch project whose config declares one stdio server
 * that touches a marker file, with HOME isolated so the folder-authorization
 * and approval stores start empty.
 */
async function runList(
  where: "project" | "global" | "mcp-json",
  opts: { yes?: boolean; decision?: Decision } = {},
): Promise<Capture & { authorized: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "sf-mcp-list-home-"));
  const project = mkdtempSync(join(tmpdir(), "sf-mcp-list-repo-"));
  const marker = join(project, "SPAWNED");
  const probe = { command: "sh", args: ["-c", `touch ${marker}`] };
  const servers = { probe };
  if (where === "mcp-json") {
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { type: "stdio", ...probe } } }));
  } else {
    const base = where === "global" ? join(home, ".seekforge") : join(project, ".seekforge");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.json"), JSON.stringify({ mcpServers: servers }));
  }

  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const previousHome = process.env["HOME"];
  const previousProfile = process.env["USERPROFILE"];
  const previousSeekforgeHome = process.env["SEEKFORGE_HOME"];
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
  delete process.env["SEEKFORGE_HOME"];
  process.chdir(project);
  try {
    const recorded = where === "mcp-json" ? { type: "stdio", ...probe } : probe;
    if (opts.decision === "approve") approveProjectMcpServer(project, "probe", recorded);
    if (opts.decision === "reject") rejectProjectMcpServer(project, "probe", recorded);
    if (opts.decision === "edit-after-approve") {
      approveProjectMcpServer(project, "probe", { ...recorded, args: ["-c", "true"] });
    }
    await mcpListCommand({ ...(opts.yes !== undefined ? { yes: opts.yes } : {}) });
  } finally {
    process.chdir(previousCwd);
    console.log = realLog;
    console.error = realError;
    process.stderr.write = realErrWrite;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousProfile;
    if (previousSeekforgeHome !== undefined) process.env["SEEKFORGE_HOME"] = previousSeekforgeHome;
    process.exitCode = previousExit;
  }
  const authorized = existsSync(join(home, ".seekforge", "authorized.json"));
  rmSync(home, { recursive: true, force: true });
  return { out, err, marker, project, authorized };
}

test("mcp list shows an unapproved repository server without starting it, even with -y", async () => {
  const { marker, out, project, authorized } = await runList("project", { yes: true });
  assert.equal(existsSync(marker), false, "a cloned repository's command must not run before it is approved");
  assert.match(out.join("\n"), /probe .*pending approval.*seekforge mcp approve probe/);
  assert.equal(authorized, false, "nothing was started, so the folder is not authorized either");
  rmSync(project, { recursive: true, force: true });
});

test("mcp list shows .mcp.json servers as pending", async () => {
  const { marker, out, project } = await runList("mcp-json", { yes: true });
  assert.equal(existsSync(marker), false);
  assert.match(out.join("\n"), /probe .*pending approval/);
  rmSync(project, { recursive: true, force: true });
});

test("an approved repository server still needs folder consent", async () => {
  const { marker, err, project } = await runList("project", { decision: "approve" });
  assert.equal(existsSync(marker), false, "approval does not replace the folder gate");
  assert.ok(
    err.join("\n").toLowerCase().includes("authoriz"),
    `expected an authorization refusal, got: ${err.join("\n")}`,
  );
  rmSync(project, { recursive: true, force: true });
});

test("mcp list starts an approved repository server once the folder is authorized", async () => {
  const { marker, project } = await runList("project", { yes: true, decision: "approve" });
  assert.equal(existsSync(marker), true, "approved + -y keeps the documented listing behavior working");
  rmSync(project, { recursive: true, force: true });
});

test("an approved .mcp.json server starts once the folder is authorized", async () => {
  const { marker, project } = await runList("mcp-json", { yes: true, decision: "approve" });
  assert.equal(existsSync(marker), true);
  rmSync(project, { recursive: true, force: true });
});

test("an approval for a different definition does not start the edited one", async () => {
  const { marker, out, project } = await runList("project", { yes: true, decision: "edit-after-approve" });
  assert.equal(existsSync(marker), false, "the digest no longer matches: pending again");
  assert.match(out.join("\n"), /pending approval/);
  rmSync(project, { recursive: true, force: true });
});

test("a rejected repository server is listed as rejected and not started", async () => {
  const { marker, out, project } = await runList("project", { yes: true, decision: "reject" });
  assert.equal(existsSync(marker), false);
  assert.match(out.join("\n"), /probe .*rejected/);
  rmSync(project, { recursive: true, force: true });
});

test("mcp list needs no folder consent for the user's own servers", async () => {
  const { marker, project, authorized } = await runList("global");
  assert.equal(existsSync(marker), true, "a server from ~/.seekforge is the user's own; no folder gate applies");
  assert.equal(authorized, false, "listing a user-owned server must not silently authorize the folder");
  rmSync(project, { recursive: true, force: true });
});
