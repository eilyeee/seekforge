#!/usr/bin/env node
/**
 * Deterministic end-to-end check for `seekforge serve`:
 * starts an isolated OpenAI-compatible provider, launches the real CLI/server,
 * verifies REST auth + endpoints, then completes one ask-mode WebSocket run.
 *
 * Usage: node scripts/serve-e2e.mjs [workspace-dir]
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Resolve ws from apps/server (it is not a root dependency).
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const WebSocket = require("ws");

const repo = fileURLToPath(new URL("..", import.meta.url));
const workspace = resolve(process.argv[2] ?? repo);
const tempHome = mkdtempSync(join(tmpdir(), "seekforge-serve-e2e-"));

const fakeProvider = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.headers.authorization !== "Bearer e2e-test-key" || !Array.isArray(payload.messages)) {
      res.writeHead(401).end();
      return;
    }

    const response = {
      id: "seekforge-e2e",
      model: payload.model ?? "e2e-model",
      choices: [{ index: 0, delta: { content: "Run pnpm test." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, prompt_cache_hit_tokens: 0 },
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(response)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

fakeProvider.listen(0, "127.0.0.1");
await once(fakeProvider, "listening");
const providerAddress = fakeProvider.address();
if (!providerAddress || typeof providerAddress === "string") {
  throw new Error("fake provider did not bind a TCP port");
}

mkdirSync(join(tempHome, ".seekforge"), { recursive: true });
writeFileSync(
  join(tempHome, ".seekforge", "config.json"),
  `${JSON.stringify(
    {
      apiKey: "e2e-test-key",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
      model: "e2e-model",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const child = spawn(`${repo}/node_modules/.bin/tsx`, [`${repo}/apps/cli/src/index.ts`, "serve", "--port", "0"], {
  cwd: workspace,
  env: { ...process.env, SEEKFORGE_HOME: tempHome },
  stdio: ["ignore", "pipe", "pipe"],
});

let baseUrl = "";
let token = "";
let startupOutput = "";
const urlRe = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-zA-Z0-9_-]+)/;

child.stdout.on("data", (chunk) => {
  startupOutput = `${startupOutput}${chunk.toString()}`.slice(-8192);
  const match = urlRe.exec(startupOutput);
  if (match) {
    baseUrl = `http://127.0.0.1:${match[1]}`;
    token = match[2];
  }
  process.stderr.write(`[serve] ${chunk}`);
});
child.stderr.on("data", (chunk) => process.stderr.write(`[serve!] ${chunk}`));

const fail = (message) => {
  throw new Error(message);
};

let ws;
let messageError;

try {
  for (let i = 0; i < 50 && !token; i++) await sleep(200);
  if (!token) fail(`server did not print a token URL within 10s\n${startupOutput}`);

  const api = (path, init = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });

  const unauth = await fetch(`${baseUrl}/api/health`);
  if (unauth.status !== 401) fail(`expected 401 without token, got ${unauth.status}`);

  const healthResponse = await api("/api/health");
  if (!healthResponse.ok) fail(`health returned ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (!health.version) fail("health missing version");
  const skillsResponse = await api("/api/skills");
  if (!skillsResponse.ok) fail(`skills returned ${skillsResponse.status}`);
  const skills = await skillsResponse.json();
  if (!Array.isArray(skills) || skills.length < 3) fail("expected >=3 skills");
  console.log(`REST ok (version ${health.version}, ${skills.length} skills)`);

  ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?token=${token}`);
  const events = [];
  let done = false;

  ws.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch (error) {
      messageError = error;
      return;
    }
    if (frame.type === "event") {
      events.push(frame.event.type);
      if (frame.event.type === "model.message") console.log(`[model] ${frame.event.content.slice(0, 120)}`);
      if (frame.event.type === "session.completed" || frame.event.type === "session.failed") {
        done = frame.event.type;
      }
    }
    if (frame.type === "permission.request") {
      ws.send(JSON.stringify({ type: "permission.response", requestId: frame.requestId, approved: false }));
    }
  });

  await Promise.race([
    new Promise((resolveOpen, rejectOpen) => {
      ws.on("open", resolveOpen);
      ws.on("error", rejectOpen);
    }),
    sleep(10_000).then(() => fail("WebSocket did not open within 10s")),
  ]);
  ws.send(
    JSON.stringify({
      type: "start",
      task: "这个项目的测试命令是什么？一句话回答",
      mode: "ask",
      approvalMode: "confirm",
    }),
  );

  for (let i = 0; i < 150 && !done && !messageError; i++) await sleep(200);
  if (messageError) fail(`invalid WebSocket frame: ${messageError.message}`);
  if (done !== "session.completed") fail(`session did not complete (got ${done}; events: ${events.join(",")})`);
  if (!events.includes("session.created")) fail("missing session.created event");
  if (!events.includes("model.message")) fail("missing model.message event");

  console.log(`WS ok (${events.length} events: ${[...new Set(events)].join(", ")})`);
  console.log("E2E PASS");
} catch (error) {
  console.error(`E2E FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  ws?.terminate();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), sleep(2_000)]);
  }
  fakeProvider.close();
  await once(fakeProvider, "close");
  rmSync(tempHome, { recursive: true, force: true });
}
