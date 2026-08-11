/**
 * The Security Center's fix budget measures the SESSION window.
 *
 * Every usage snapshot the agent publishes carries a run-scoped total and a
 * session-scoped one. The run total restarts at zero whenever a session is
 * resumed, so a budget that reads it under-bills; this route must read the
 * session total and must also honour the final report, for a provider that
 * only reports usage at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import { startServer, type RunningServer } from "../src/index.js";
import { fakeAgentFactory, makeWorkspace, writeFileIn } from "./helpers.js";

vi.mock("@seekforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seekforge/core")>();
  return {
    ...actual,
    runProjectSecurityChecks: async ({ verifyCommand }: { verifyCommand: string }) => [
      {
        kind: "verify" as const,
        command: verifyCommand,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      },
    ],
  };
});

const TOKEN = "test-token-security-budget";

const findingEnvelope = JSON.stringify({
  findings: [
    {
      title: "Query parameter is used as a password",
      description: "Credentials supplied in query strings can leak through logs and browser history.",
      severity: "high",
      confidence: "high",
      category: "credential-exposure",
      cwe: "CWE-598",
      ruleId: "credentials-in-query",
      recommendation: "Read credentials from an authorization header and reject query-string credentials.",
      evidence: [
        { path: "src/server.ts", lineStart: 1, lineEnd: 1, excerpt: "const password = request.query.password;" },
      ],
    },
  ],
});

const usage = (costUsd: number) => ({ promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd });

const report = (costUsd: number, sessionCostUsd: number) => ({
  summary: "fix attempted",
  changedFiles: [],
  commandsRun: [],
  verification: "no commands were run",
  usage: usage(costUsd),
  sessionUsage: usage(sessionCostUsd),
});

let workspace: string;
let server: RunningServer;
let base: string;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

/** Boots a server whose "fix" runs emit the given usage script. */
async function bootWith(fixEvents: () => AgentEvent[]): Promise<void> {
  workspace = makeWorkspace();
  writeFileIn(workspace, "src/server.ts", "const password = request.query.password;\n");
  let scans = 0;
  const createAgent = fakeAgentFactory(async function* (_options, input) {
    yield { type: "session.created", sessionId: `sec-${++scans}` };
    if (input.task.includes("repository-wide security review")) {
      yield { type: "model.message", content: scans === 1 ? findingEnvelope : JSON.stringify({ findings: [] }) };
      yield { type: "session.completed", report: report(0, 0) };
      return;
    }
    for (const event of fixEvents()) yield event;
  });
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent });
  base = `http://127.0.0.1:${server.port}`;
}

async function scanAndFix(maxCostUsd: number): Promise<{ status: string }> {
  const scanRes = await request("/api/security/scan", { method: "POST", body: JSON.stringify({ maxFindings: 10 }) });
  const scan = (await scanRes.json()) as { findings: Array<{ id: string }> };
  if (!scan.findings) throw new Error(`scan failed ${scanRes.status}: ${JSON.stringify(scan)}`);
  const res = await request(`/api/security/findings/${scan.findings[0]!.id}/fix`, {
    method: "POST",
    body: JSON.stringify({ verifyCommand: "true", maxCostUsd }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fix: { status: string } };
  return body.fix;
}

describe("security fix cost budget", () => {
  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stops the fix when the SESSION total reaches the budget, even if this run's total has not", async () => {
    await bootWith(() => [
      { type: "usage.updated", usage: usage(0.01), sessionUsage: usage(0.9) },
      { type: "session.completed", report: report(0.01, 0.9) },
    ]);

    // The budget tripped, so no verification may be recorded for this finding.
    expect((await scanAndFix(0.5)).status).not.toBe("verified");
  });

  it("honours the final report when usage is only reported at the end", async () => {
    await bootWith(() => [{ type: "session.completed", report: report(0.9, 0.9) }]);

    expect((await scanAndFix(0.5)).status).not.toBe("verified");
  });

  it("verifies a fix that stays inside the budget", async () => {
    await bootWith(() => [
      { type: "usage.updated", usage: usage(0.01), sessionUsage: usage(0.01) },
      { type: "session.completed", report: report(0.01, 0.01) },
    ]);

    expect((await scanAndFix(0.5)).status).toBe("verified");
  });
});
