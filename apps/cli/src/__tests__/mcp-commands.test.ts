// `seekforge mcp add | add-json | get | import | approve | reject | reset-project-choices`
// against a scratch HOME and project.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { projectMcpServerStatus } from "@seekforge/core";
import {
  mcpAddCommand,
  mcpAddJsonCommand,
  mcpApproveCommand,
  mcpGetCommand,
  mcpImportCommand,
  mcpRejectCommand,
  mcpRemoveCommand,
  mcpResetProjectChoicesCommand,
} from "../commands/mcp.js";
import {
  claudeDesktopConfigPaths,
  collectMcpImportCandidates,
  mcpAddDefinition,
  resolveMcpScope,
} from "../mcp-config.js";

let home: string;
let project: string;
let out: string[];
let err: string[];
const saved = {
  log: console.log,
  error: console.error,
  write: process.stderr.write.bind(process.stderr),
  cwd: process.cwd(),
  exit: process.exitCode,
  home: process.env["HOME"],
  profile: process.env["USERPROFILE"],
  seekforgeHome: process.env["SEEKFORGE_HOME"],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sf-mcp-cmd-home-"));
  project = mkdtempSync(join(tmpdir(), "sf-mcp-cmd-repo-"));
  out = [];
  err = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  delete process.env["SEEKFORGE_HOME"];
  process.exitCode = undefined;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(saved.cwd);
  console.log = saved.log;
  console.error = saved.error;
  process.stderr.write = saved.write;
  for (const [key, value] of [
    ["HOME", saved.home],
    ["USERPROFILE", saved.profile],
    ["SEEKFORGE_HOME", saved.seekforgeHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = saved.exit;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const userConfig = () => readJson(join(home, ".seekforge", "config.json"));
const projectConfig = (file = "config.json") => readJson(join(project, ".seekforge", file));

test("mcp add writes http and sse servers with headers, and stdio servers with env", () => {
  mcpAddCommand("docs", ["https://docs.example/mcp"], {
    transport: "http",
    header: ["Authorization: Bearer ${DOCS_TOKEN}"],
    scope: "user",
    trust: true,
  });
  mcpAddCommand("legacy", ["https://old.example/sse"], { transport: "sse", global: true });
  mcpAddCommand("fs", ["npx", "-y", "server-fs", "."], { env: ["ROOT=/data", "MODE=ro"] });
  assert.equal(process.exitCode, undefined, err.join("\n"));
  assert.deepEqual(userConfig()["mcpServers"], {
    docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, trusted: true },
    legacy: { type: "sse", url: "https://old.example/sse" },
  });
  assert.deepEqual(projectConfig()["mcpServers"], {
    fs: { command: "npx", args: ["-y", "server-fs", "."], env: { ROOT: "/data", MODE: "ro" } },
  });
  assert.match(out.join("\n"), /pending approval: run `seekforge mcp approve fs`/);
});

test("mcp add --trust in a project scope approves exactly what it wrote", () => {
  mcpAddCommand("local-fs", ["node", "server.js"], { scope: "local", trust: true });
  assert.equal(process.exitCode, undefined, err.join("\n"));
  assert.deepEqual(projectConfig("config.local.json")["mcpServers"], {
    "local-fs": { command: "node", args: ["server.js"] },
  });
  assert.equal(projectMcpServerStatus(project, "local-fs", { command: "node", args: ["server.js"] }), "approved");
  // Project scope never writes trusted: true — the approval is the trust.
  assert.equal(
    "trusted" in (projectConfig("config.local.json")["mcpServers"] as Record<string, object>)["local-fs"]!,
    false,
  );
});

test("mcp add --trust does not approve a same-named entry from a higher-precedence project file", () => {
  mcpAddCommand("fs", ["local-server"], { scope: "local" });
  mcpAddCommand("fs", ["project-server"], { trust: true });
  assert.equal(process.exitCode, undefined, err.join("\n"));
  assert.match(out.join("\n"), /another project file defines "fs"/);
  assert.equal(projectMcpServerStatus(project, "fs", { command: "local-server" }), "pending");
  assert.equal(projectMcpServerStatus(project, "fs", { command: "project-server" }), "pending");
});

test("mcp add refuses mismatched flags without writing", () => {
  mcpAddCommand("x", ["https://a", "extra"], { transport: "http" });
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  mcpAddCommand("x", ["npx"], { header: ["A: b"] });
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  mcpAddCommand("x", ["npx"], { global: true, scope: "project" });
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  mcpAddCommand("x", ["npx"], { transport: "websocket" });
  assert.equal(process.exitCode, 1);
  assert.match(err.join("\n"), /--header applies to http and sse servers/);
  assert.throws(() => projectConfig());
});

test("mcp add-json accepts Claude Code's format and refuses trust in a project scope", () => {
  mcpAddJsonCommand("gh", '{"type":"http","url":"https://api.example/mcp","headers":{"X-Key":"${KEY}"}}', {
    global: true,
    trust: true,
  });
  assert.deepEqual((userConfig()["mcpServers"] as Record<string, unknown>)["gh"], {
    type: "http",
    url: "https://api.example/mcp",
    headers: { "X-Key": "${KEY}" },
    trusted: true,
  });
  mcpAddJsonCommand("bad", '{"command":"x","trusted":true}', {});
  assert.equal(process.exitCode, 1);
  assert.match(err.join("\n"), /cannot carry "trusted"/);
  process.exitCode = undefined;
  mcpAddJsonCommand("bad", "{not json", {});
  assert.match(err.join("\n"), /not valid JSON/);
  process.exitCode = undefined;
  mcpAddJsonCommand("bad", '{"command":"x","alwaysAllow":[]}', {});
  assert.match(err.join("\n"), /unsupported field\(s\): alwaysAllow/);
});

test("approve / reject / reset act only on repository servers and follow the definition", async () => {
  mkdirSync(join(project, ".seekforge"), { recursive: true });
  const definition = { command: "node", args: ["repo-server.js"], env: { TOKEN: "${GITHUB_TOKEN}" } };
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { repo: definition } }));
  mkdirSync(join(home, ".seekforge"), { recursive: true });
  writeFileSync(join(home, ".seekforge", "config.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } } }));

  mcpGetCommand("repo");
  assert.match(out.join("\n"), /pending approval/);
  // The review shows the template, not the value.
  assert.match(out.join("\n"), /"TOKEN": "\$\{GITHUB_TOKEN\}"/);

  await mcpApproveCommand("mine", { yes: true });
  assert.equal(process.exitCode, 1);
  assert.match(err.join("\n"), /defined in your own config/);
  process.exitCode = undefined;

  await mcpApproveCommand("repo", { yes: true });
  assert.equal(projectMcpServerStatus(project, "repo", definition), "approved");
  out.length = 0;
  mcpGetCommand("repo");
  assert.match(out.join("\n"), /approved for this workspace/);

  mcpRejectCommand("repo");
  assert.equal(projectMcpServerStatus(project, "repo", definition), "rejected");

  mcpResetProjectChoicesCommand();
  assert.equal(projectMcpServerStatus(project, "repo", definition), "pending");
  assert.match(out.join("\n"), /forgot 1 MCP decision/);
});

test("mcp approve without -y refuses when nobody can answer", async () => {
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "node" } } }));
  const tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await mcpApproveCommand("repo", {});
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  }
  assert.equal(process.exitCode, 1);
  assert.equal(projectMcpServerStatus(project, "repo", { command: "node" }), "pending");
});

test("mcp remove honors --scope", () => {
  mcpAddCommand("a", ["x"], { scope: "local" });
  mcpRemoveCommand("a", { scope: "local" });
  assert.equal(process.exitCode, undefined, err.join("\n"));
  assert.equal(projectConfig("config.local.json")["mcpServers"], undefined);
});

test("mcp import previews Claude Desktop and Claude Code servers and writes them trusted", async () => {
  const desktop = claudeDesktopConfigPaths(home, process.platform, process.env)[0]!;
  mkdirSync(join(desktop, ".."), { recursive: true });
  writeFileSync(
    desktop,
    JSON.stringify({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"] },
        existing: { command: "dup" },
      },
    }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        linear: { type: "sse", url: "https://mcp.linear.app/sse" },
        filesystem: { command: "other" },
        broken: { type: "http" },
      },
      projects: {
        [project]: {
          mcpServers: { notes: { type: "stdio", command: "notes-mcp", env: {}, oauth: { clientId: "x" } } },
        },
        "/somewhere/else": { mcpServers: { unrelated: { command: "nope" } } },
      },
    }),
  );
  mkdirSync(join(home, ".seekforge"), { recursive: true });
  writeFileSync(
    join(home, ".seekforge", "config.json"),
    JSON.stringify({ model: "m", mcpServers: { existing: { command: "mine" } } }),
  );

  await mcpImportCommand({ yes: true });
  assert.equal(process.exitCode, undefined, err.join("\n"));
  const printed = out.join("\n");
  assert.match(printed, /filesystem .*from claude-desktop/);
  assert.match(printed, /existing\s+skipped/);
  assert.match(printed, /broken\s+skipped — an http server needs a url/);
  assert.match(printed, /dropped unsupported fields: oauth/);
  assert.doesNotMatch(printed, /unrelated/);
  const config = userConfig();
  assert.equal(config["model"], "m");
  assert.deepEqual(config["mcpServers"], {
    existing: { command: "mine" },
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"], trusted: true },
    linear: { type: "sse", url: "https://mcp.linear.app/sse", trusted: true },
    notes: { type: "stdio", command: "notes-mcp", trusted: true },
  });
});

test("mcp import --no-trust and --from narrow what is written", async () => {
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://l.example/mcp" } } }),
  );
  const desktop = claudeDesktopConfigPaths(home, process.platform, process.env)[0]!;
  mkdirSync(join(desktop, ".."), { recursive: true });
  writeFileSync(desktop, JSON.stringify({ mcpServers: { fromDesktop: { command: "x" } } }));
  await mcpImportCommand({ yes: true, trust: false, from: "claude-code" });
  assert.deepEqual(userConfig()["mcpServers"], { linear: { url: "https://l.example/mcp" } });
});

test("mcp import without -y refuses when nobody can answer", async () => {
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://l.example/mcp" } } }),
  );
  const tty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await mcpImportCommand({});
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  }
  assert.equal(process.exitCode, 1);
  assert.throws(() => userConfig());
});

test("helpers: scope resolution, add definitions, desktop paths", () => {
  assert.equal(resolveMcpScope({}), "project");
  assert.equal(resolveMcpScope({ global: true }), "user");
  assert.equal(resolveMcpScope({ scope: "local" }), "local");
  assert.throws(() => resolveMcpScope({ scope: "team" }));
  assert.deepEqual(mcpAddDefinition({ transport: "sse", target: ["https://a/sse"], env: [], headers: [] }), {
    type: "sse",
    url: "https://a/sse",
  });
  assert.throws(() => mcpAddDefinition({ transport: "http", target: ["https://a"], env: [["A", "b"]], headers: [] }));
  assert.deepEqual(claudeDesktopConfigPaths("/h", "darwin", {}), [
    "/h/Library/Application Support/Claude/claude_desktop_config.json",
  ]);
  assert.deepEqual(claudeDesktopConfigPaths("/h", "linux", {}), ["/h/.config/Claude/claude_desktop_config.json"]);
  assert.deepEqual(claudeDesktopConfigPaths("/h", "linux", { XDG_CONFIG_HOME: "/x" }), [
    "/x/Claude/claude_desktop_config.json",
  ]);
  assert.equal(
    claudeDesktopConfigPaths("C:\\Users\\me", "win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })[0]?.includes(
      "Claude",
    ),
    true,
  );
  const { candidates, problems } = collectMcpImportCandidates("claude-code", {
    home: "/h",
    platform: "linux",
    env: {},
    projectPath: "/p",
    readText: (path) => (path === "/h/.claude.json" ? "[1,2]" : undefined),
  });
  assert.deepEqual(candidates, []);
  assert.deepEqual(problems, [{ name: "*", source: "/h/.claude.json", reason: "not a JSON object" }]);
});
