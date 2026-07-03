import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import {
  buildTriggerTask,
  checkTriggerSecret,
  loadTriggers,
  maskTrigger,
  payloadToTaskSuffix,
  validateTrigger,
  type Trigger,
} from "../src/triggers.js";
import { fakeAgentFactory, makeWorkspace, writeFileIn } from "./helpers.js";

// --- Pure module: validation ------------------------------------------------

describe("validateTrigger", () => {
  const good = {
    id: "ci",
    task: "review the latest push",
    mode: "edit",
    maxCostUsd: 0.5,
    secret: "shhhhhh-secret",
  };

  it("accepts a well-formed trigger and defaults enabled to true", () => {
    const result = validateTrigger(good);
    expect("trigger" in result).toBe(true);
    if ("trigger" in result) {
      expect(result.trigger.enabled).toBe(true);
      expect(result.trigger.maxCostUsd).toBe(0.5);
    }
  });

  it("rejects a trigger with no maxCostUsd", () => {
    const { maxCostUsd: _omit, ...noBudget } = good;
    const result = validateTrigger(noBudget);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/maxCostUsd/);
  });

  it("rejects a non-positive maxCostUsd", () => {
    const result = validateTrigger({ ...good, maxCostUsd: 0 });
    expect("error" in result).toBe(true);
  });

  it("rejects a trigger with no secret", () => {
    const { secret: _omit, ...noSecret } = good;
    const result = validateTrigger(noSecret);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/secret/);
  });

  it("rejects a too-short secret", () => {
    const result = validateTrigger({ ...good, secret: "short" });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/secret/);
  });

  it("rejects an id with path separators", () => {
    const result = validateTrigger({ ...good, id: "../escape" });
    expect("error" in result).toBe(true);
  });

  it("rejects an invalid mode", () => {
    const result = validateTrigger({ ...good, mode: "yolo" });
    expect("error" in result).toBe(true);
  });
});

// --- Pure module: secret auth (constant-time) -------------------------------

describe("checkTriggerSecret", () => {
  it("accepts the exact secret", () => {
    expect(checkTriggerSecret("correct-horse", "correct-horse")).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(checkTriggerSecret("correct-horse", "wrong-horse")).toBe(false);
  });

  it("rejects a missing/empty secret without throwing", () => {
    expect(checkTriggerSecret("correct-horse", null)).toBe(false);
    expect(checkTriggerSecret("correct-horse", undefined)).toBe(false);
    expect(checkTriggerSecret("correct-horse", "")).toBe(false);
  });

  it("rejects a secret that is a prefix of the real one (hashed compare)", () => {
    expect(checkTriggerSecret("correct-horse", "correct")).toBe(false);
  });
});

// --- Pure module: masking + payload → task ----------------------------------

describe("maskTrigger", () => {
  it("redacts the secret", () => {
    const t: Trigger = {
      id: "x",
      task: "t",
      mode: "ask",
      maxCostUsd: 1,
      secret: "super-secret-value",
      enabled: true,
    };
    expect(maskTrigger(t).secret).toBe("***");
  });
});

describe("payloadToTaskSuffix / buildTriggerTask", () => {
  it("returns empty for no payload", () => {
    expect(payloadToTaskSuffix(undefined)).toBe("");
    expect(payloadToTaskSuffix(null)).toBe("");
  });

  it("summarises a GitHub-style webhook payload", () => {
    const suffix = payloadToTaskSuffix({
      action: "opened",
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 42, title: "Fix the flux capacitor" },
      sender: { login: "octocat" },
    });
    expect(suffix).toMatch(/action=opened/);
    expect(suffix).toMatch(/repo=acme\/widgets/);
    expect(suffix).toMatch(/pr=#42/);
    expect(suffix).toMatch(/sender=octocat/);
  });

  it("falls back to top-level keys for an unknown object shape", () => {
    const suffix = payloadToTaskSuffix({ foo: 1, bar: 2 });
    expect(suffix).toMatch(/keys: foo, bar/);
  });

  it("appends the summary to the task with a blank line", () => {
    const task = buildTriggerTask("do the thing", { action: "push" });
    expect(task).toBe("do the thing\n\nTriggering event: action=push");
  });

  it("leaves the task unchanged when there is no payload", () => {
    expect(buildTriggerTask("do the thing", undefined)).toBe("do the thing");
  });
});

// --- Endpoint tests (fake agent factory — no real LLM call) -----------------

const TOKEN = "test-token-triggers";
let workspace: string;
let server: RunningServer;
let base: string;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(r: Response | Promise<Response>): Promise<any> {
  return (await r).json();
}

beforeAll(async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["SEEKFORGE_RUNTIME_BIN"];
  workspace = makeWorkspace();
  writeFileIn(
    workspace,
    ".seekforge/config.json",
    JSON.stringify({ apiKey: "sk-test123456", model: "deepseek-chat" }),
  );
  // A fake agent that immediately reports a created + completed session, so the
  // fire endpoint can resolve with a session id without any real run.
  const createAgent = fakeAgentFactory(async function* () {
    yield { type: "session.created", sessionId: "trig-session-1" };
    yield {
      type: "session.completed",
      report: {
        summary: "done",
        changedFiles: [],
        commandsRun: [],
        verification: "no commands were run",
        usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
      },
    };
  });
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("trigger management endpoints", () => {
  it("POST /api/triggers creates a trigger and masks the secret", async () => {
    const res = await authed("/api/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ci",
        task: "review the push",
        mode: "edit",
        maxCostUsd: 0.25,
        secret: "trigger-secret-1",
      }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.id).toBe("ci");
    expect(body.secret).toBe("***");
    // The on-disk secret is the real one (not masked).
    expect(loadTriggers(workspace).find((t) => t.id === "ci")?.secret).toBe("trigger-secret-1");
  });

  it("POST /api/triggers rejects a trigger with no budget", async () => {
    const res = await authed("/api/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "nobudget", task: "t", mode: "ask", secret: "trigger-secret-2" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.message).toMatch(/maxCostUsd/);
  });

  it("GET /api/triggers lists triggers with secrets masked", async () => {
    const list = await jsonOf(authed("/api/triggers"));
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((t: { secret: string }) => t.secret === "***")).toBe(true);
  });
});

describe("trigger fire endpoint (dual auth + headless run)", () => {
  it("POST /api/triggers/:id with the right token+secret returns 202 + session id", async () => {
    const res = await authed("/api/triggers/ci", {
      method: "POST",
      headers: { "content-type": "application/json", "x-seekforge-trigger-secret": "trigger-secret-1" },
      body: JSON.stringify({ action: "opened", repository: { full_name: "acme/widgets" } }),
    });
    expect(res.status).toBe(202);
    const body = await jsonOf(res);
    expect(body.sessionId).toBe("trig-session-1");
    expect(body.triggerId).toBe("ci");
  });

  it("accepts the secret via ?secret= query as well", async () => {
    const res = await authed("/api/triggers/ci?secret=trigger-secret-1", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("rejects a wrong secret with 403", async () => {
    const res = await authed("/api/triggers/ci", {
      method: "POST",
      headers: { "x-seekforge-trigger-secret": "wrong-secret" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing secret with 403", async () => {
    const res = await authed("/api/triggers/ci", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown trigger id", async () => {
    const res = await authed("/api/triggers/does-not-exist", {
      method: "POST",
      headers: { "x-seekforge-trigger-secret": "whatever" },
    });
    expect(res.status).toBe(404);
  });

  it("requires the server bearer token too (no token → 401)", async () => {
    const res = await fetch(`${base}/api/triggers/ci`, {
      method: "POST",
      headers: { "x-seekforge-trigger-secret": "trigger-secret-1" },
    });
    expect(res.status).toBe(401);
  });
});

describe("trigger delete + disabled", () => {
  it("DELETE /api/triggers/:id removes a trigger", async () => {
    await authed("/api/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "temp",
        task: "t",
        mode: "ask",
        maxCostUsd: 1,
        secret: "trigger-secret-3",
      }),
    });
    const res = await authed("/api/triggers/temp", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).deleted).toBe(true);
    expect(loadTriggers(workspace).some((t) => t.id === "temp")).toBe(false);
  });

  it("DELETE /api/triggers/:id 404s for an unknown id", async () => {
    const res = await authed("/api/triggers/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("a disabled trigger returns 409 even with the right secret", async () => {
    await authed("/api/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "off",
        task: "t",
        mode: "ask",
        maxCostUsd: 1,
        secret: "trigger-secret-4",
        enabled: false,
      }),
    });
    const res = await authed("/api/triggers/off", {
      method: "POST",
      headers: { "x-seekforge-trigger-secret": "trigger-secret-4" },
    });
    expect(res.status).toBe(409);
  });
});
