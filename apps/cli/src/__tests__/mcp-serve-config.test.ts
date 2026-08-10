// `seekforge mcp-serve` used to be the one CLI entry point that never read the
// workspace configuration: no permission rules, no hooks, no sandbox, and none
// of the builtin-tool configuration every other command applies. This drives
// the real command over real stdio and checks that a user's hardening actually
// arrives — including the layering, where a repository may contribute deny
// rules but not hooks.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

type JsonRpcResponse = {
  id: number;
  result?: { content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
};

/** Speaks newline-delimited JSON-RPC to a spawned `mcp-serve` child. */
function driver(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 1;
  const send = (method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const answer = new Promise<JsonRpcResponse>((res) => pending.set(id, res));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answer;
  };
  return {
    async ready(): Promise<void> {
      await send("initialize", { protocolVersion: "2025-06-18" });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async readFile(path: string): Promise<string> {
      const res = await send("tools/call", { name: "read_file", arguments: { path } });
      assert.equal(res.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(res.error)}`);
      assert.equal(res.result?.isError, true, `expected the call to be refused: ${JSON.stringify(res.result)}`);
      return res.result?.content?.[0]?.text ?? "";
    },
  };
}

// Spawns the whole CLI through the tsx loader, which is slow on a cold cache.
test("mcp-serve applies the workspace's permission rules and the user's hooks", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "seekforge-mcpserve-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(join(workspace, ".seekforge"), { recursive: true });
  mkdirSync(join(home, ".seekforge"), { recursive: true });
  writeFileSync(join(workspace, "secret.txt"), "classified\n");
  writeFileSync(join(workspace, "public.txt"), "readable\n");

  // Repository layer: sanitizeProjectConfig keeps deny rules and drops
  // everything a repository must not decide for the user.
  writeFileSync(
    join(workspace, ".seekforge", "config.json"),
    JSON.stringify({ permissionRules: [{ action: "deny", tool: "read_file", match: "secret.txt" }] }),
  );
  // User layer: hooks are user-owned, so this one is the one that runs.
  writeFileSync(
    join(home, ".seekforge", "config.json"),
    JSON.stringify({ hooks: { preToolUse: [{ command: "exit 7" }] } }),
  );

  const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(
    process.execPath,
    ["--import", resolve(cliDir, "node_modules/tsx/dist/loader.mjs"), resolve(cliDir, "src/index.ts"), "mcp-serve"],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", SEEKFORGE_HOME: join(home, ".seekforge") },
    },
  ) as ChildProcessWithoutNullStreams;

  try {
    const mcp = driver(child);
    await mcp.ready();
    // The deny rule is checked before any hook and blocks even an L0 read.
    assert.match(await mcp.readFile("secret.txt"), /denied_by_rule/);
    // Anything the rules allow still has to survive the preToolUse hook.
    assert.match(await mcp.readFile("public.txt"), /hook_blocked/);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
