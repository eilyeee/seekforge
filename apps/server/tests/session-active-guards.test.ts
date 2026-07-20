import { existsSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const activeState = vi.hoisted(() => ({
  sessionIds: new Set<string>(),
  anySession: false,
  rewindFails: false,
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@seekforge/core")>();
  return {
    ...original,
    isSessionRunActive: (_workspace: string, sessionId: string) => activeState.sessionIds.has(sessionId),
    hasActiveSessionRuns: () => activeState.anySession,
    rewindSessionToTurn: (...args: Parameters<typeof original.rewindSessionToTurn>) => {
      if (activeState.rewindFails) throw new Error("checkpoint restore failed");
      return original.rewindSessionToTurn(...args);
    },
  };
});

import { startServer, type RunningServer } from "../src/index.js";
import { acquireSessionLease } from "@seekforge/core";
import { makeWorkspace, unusedAgentFactory, writeFileIn } from "./helpers.js";

const TOKEN = "test-token-active-session-guards";

let workspace: string;
let server: RunningServer;
let base: string;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
}

async function expectSessionBusy(response: Promise<Response>): Promise<void> {
  const res = await response;
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_busy");
}

beforeAll(async () => {
  workspace = makeWorkspace();
  for (const [id, createdAt] of [
    ["active", "2026-01-02T00:00:00.000Z"],
    ["old", "2026-01-01T00:00:00.000Z"],
  ] as const) {
    writeFileIn(
      workspace,
      `.seekforge/sessions/${id}/session.json`,
      JSON.stringify({ id, task: id, mode: "edit", status: "completed", createdAt, updatedAt: createdAt }),
    );
  }
  writeFileIn(
    workspace,
    ".seekforge/sessions/active/messages.jsonl",
    [
      { ts: "2026-01-02T00:00:00.000Z", role: "user", content: "start" },
      { ts: "2026-01-02T00:00:01.000Z", role: "assistant", content: "working" },
      { ts: "2026-01-02T00:00:02.000Z", role: "user", content: "continue" },
    ]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join(""),
  );
  writeFileIn(
    workspace,
    ".seekforge/sessions/active/checkpoints.jsonl",
    `${JSON.stringify({ ts: "2026-01-02T00:00:01.000Z", path: "src/active.txt", before: "before\n" })}\n`,
  );
  writeFileIn(workspace, "src/active.txt", "during\n");
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: unusedAgentFactory });
  base = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
  activeState.sessionIds.clear();
  activeState.anySession = false;
  activeState.rewindFails = false;
});

afterAll(async () => {
  await server.close();
});

describe("active-session REST guards", () => {
  it("rejects compact without changing the trace", async () => {
    activeState.sessionIds.add("active");
    const messagesPath = join(workspace, ".seekforge/sessions/active/messages.jsonl");
    const before = readFileSync(messagesPath, "utf8");

    await expectSessionBusy(authed("/api/sessions/active/compact", { method: "POST" }));

    expect(readFileSync(messagesPath, "utf8")).toBe(before);
  });

  it("rejects fork without creating a session", async () => {
    activeState.sessionIds.add("active");
    const sessionsDir = join(workspace, ".seekforge/sessions");
    const before = readdirSync(sessionsDir).sort();

    await expectSessionBusy(authed("/api/sessions/active/fork", { method: "POST" }));

    expect(readdirSync(sessionsDir).sort()).toEqual(before);
  });

  it("rejects delete without removing the session", async () => {
    activeState.sessionIds.add("active");

    await expectSessionBusy(authed("/api/sessions/active", { method: "DELETE" }));

    expect(existsSync(join(workspace, ".seekforge/sessions/active/session.json"))).toBe(true);
  });

  it("rejects backtrack without truncating the trace", async () => {
    const messagesPath = join(workspace, ".seekforge/sessions/active/messages.jsonl");
    const before = readFileSync(messagesPath, "utf8");
    let lease: ReturnType<typeof acquireSessionLease> | undefined;
    const response = new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const req = request(`${base}/api/sessions/active/backtrack`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.write('{"turn":');
      setTimeout(() => {
        lease = acquireSessionLease(workspace, "active");
        req.end('1,"files":true}');
      }, 50);
    });
    const result = await response;
    try {
      expect(result.status).toBe(409);
      expect((JSON.parse(result.body) as { error: { code: string } }).error.code).toBe("session_busy");
    } finally {
      lease?.release();
    }

    expect(readFileSync(messagesPath, "utf8")).toBe(before);
    expect(readFileSync(join(workspace, "src/active.txt"), "utf8")).toBe("during\n");
  });

  it("does not truncate the trace when checkpoint restoration fails", async () => {
    const messagesPath = join(workspace, ".seekforge/sessions/active/messages.jsonl");
    const before = readFileSync(messagesPath, "utf8");
    activeState.rewindFails = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await authed("/api/sessions/active/backtrack", {
        method: "POST",
        body: JSON.stringify({ turn: 1, files: true }),
      });
      expect(res.status).toBe(500);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(messagesPath, "utf8")).toBe(before);
  });

  it("rejects rewind without restoring files", async () => {
    activeState.sessionIds.add("active");

    await expectSessionBusy(
      authed("/api/rewind", {
        method: "POST",
        body: JSON.stringify({ sessionId: "active" }),
      }),
    );

    expect(readFileSync(join(workspace, "src/active.txt"), "utf8")).toBe("during\n");
  });

  it("rejects destructive prune without removing any session", async () => {
    activeState.anySession = true;
    const sessionsDir = join(workspace, ".seekforge/sessions");
    const before = readdirSync(sessionsDir).sort();

    await expectSessionBusy(
      authed("/api/sessions/prune", {
        method: "POST",
        body: JSON.stringify({ keepLast: 0 }),
      }),
    );

    expect(readdirSync(sessionsDir).sort()).toEqual(before);
  });

  it("rejects project settings mutations while another session owns the workspace", async () => {
    const lease = acquireSessionLease(workspace, "settings-active");
    try {
      await expectSessionBusy(
        authed("/api/hooks", {
          method: "PUT",
          body: JSON.stringify({ hooks: { preToolUse: [{ command: "echo blocked" }] } }),
        }),
      );
      await expectSessionBusy(
        authed("/api/config", {
          method: "PUT",
          body: JSON.stringify({ key: "sandbox", value: "off" }),
        }),
      );
      await expectSessionBusy(
        authed("/api/mcp", {
          method: "POST",
          body: JSON.stringify({ name: "blocked", command: "node" }),
        }),
      );
    } finally {
      lease.release();
    }

    expect(existsSync(join(workspace, ".seekforge/config.json"))).toBe(false);
  });
});
