#!/usr/bin/env node
/**
 * Live end-to-end check for `seekforge serve`:
 * spawns the server in a given workspace, verifies REST auth + endpoints,
 * then drives one ask-mode session over WebSocket until completion.
 *
 * Usage: node scripts/serve-e2e.mjs <workspace-dir>
 * Needs DEEPSEEK_API_KEY (or configured key) for the live session.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Resolve ws from apps/server (it is not a root dependency).
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const WebSocket = require("ws");

const workspace = process.argv[2];
if (!workspace) {
  console.error("usage: node scripts/serve-e2e.mjs <workspace-dir>");
  process.exit(1);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(`${repo}/node_modules/.bin/tsx`, [`${repo}/apps/cli/src/index.ts`, "serve", "--port", "0"], {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe"],
});

let baseUrl = "";
let token = "";
const urlRe = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-zA-Z0-9_-]+)/;

child.stdout.on("data", (c) => {
  const m = urlRe.exec(c.toString());
  if (m) {
    baseUrl = `http://127.0.0.1:${m[1]}`;
    token = m[2];
  }
  process.stderr.write(`[serve] ${c}`);
});
child.stderr.on("data", (c) => process.stderr.write(`[serve!] ${c}`));

const fail = (msg) => {
  console.error(`E2E FAIL: ${msg}`);
  child.kill();
  process.exit(1);
};

// wait for the token URL
for (let i = 0; i < 50 && !token; i++) await sleep(200);
if (!token) fail("server did not print a token URL within 10s");

const api = (path, init = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });

// 1. auth required
const unauth = await fetch(`${baseUrl}/api/health`);
if (unauth.status !== 401) fail(`expected 401 without token, got ${unauth.status}`);

// 2. REST happy paths
const health = await (await api("/api/health")).json();
if (!health.version) fail("health missing version");
const skills = await (await api("/api/skills")).json();
if (!Array.isArray(skills) || skills.length < 3) fail("expected >=3 skills");
console.log(`REST ok (version ${health.version}, ${skills.length} skills)`);

// 3. WS session (ask mode, cheap)
const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?token=${token}`);
const events = [];
let done = false;

ws.on("message", (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === "event") {
    events.push(frame.event.type);
    if (frame.event.type === "model.message") {
      console.log(`[model] ${frame.event.content.slice(0, 120)}`);
    }
    if (frame.event.type === "session.completed" || frame.event.type === "session.failed") {
      done = frame.event.type;
    }
  }
  if (frame.type === "permission.request") {
    // ask mode should not request permissions; deny if it does
    ws.send(JSON.stringify({ type: "permission.response", requestId: frame.requestId, approved: false }));
  }
});

await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
ws.send(
  JSON.stringify({ type: "start", task: "这个项目的测试命令是什么？一句话回答", mode: "ask", approvalMode: "confirm" }),
);

for (let i = 0; i < 600 && !done; i++) await sleep(200);
if (done !== "session.completed") fail(`session did not complete (got ${done}; events: ${events.join(",")})`);
if (!events.includes("session.created")) fail("missing session.created event");

console.log(`WS ok (${events.length} events: ${[...new Set(events)].join(", ")})`);
ws.close();
child.kill();
console.log("E2E PASS");
