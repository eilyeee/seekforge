import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/index.js";
import { emptyReport, fakeAgentFactory, makeWorkspace, writeFileIn } from "./helpers.js";

vi.mock("@seekforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seekforge/core")>();
  return {
    ...actual,
    runProjectSecurityChecks: async ({ verifyCommand }: { verifyCommand: string }) => [{
      kind: "verify" as const,
      command: verifyCommand,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }],
  };
});

const TOKEN = "test-token-security";

let workspace: string;
let server: RunningServer;
let base: string;
let scanCount = 0;

const findingEnvelope = JSON.stringify({
  findings: [{
    title: "Query parameter is used as a password",
    description: "Credentials supplied in query strings can leak through logs and browser history.",
    severity: "high",
    confidence: "high",
    category: "credential-exposure",
    cwe: "CWE-598",
    ruleId: "credentials-in-query",
    recommendation: "Read credentials from an authorization header and reject query-string credentials.",
    evidence: [{
      path: "src/server.ts",
      lineStart: 1,
      lineEnd: 1,
      excerpt: "const password = request.query.password;",
    }],
  }],
});

const threatModelEnvelope = JSON.stringify({
  summary: "The HTTP boundary accepts credentials and reaches application state.",
  assets: [{ name: "Credentials", description: "User authentication secrets.", evidence: [{ path: "src/server.ts", lineStart: 1, lineEnd: 1 }] }],
  entryPoints: [{ name: "HTTP request", description: "Public request input.", evidence: [{ path: "src/server.ts", lineStart: 1, lineEnd: 1 }] }],
  trustBoundaries: [{ name: "Network boundary", description: "Untrusted requests enter the process.", evidence: [{ path: "src/server.ts", lineStart: 1, lineEnd: 1 }] }],
  dataFlows: [{ name: "Credential lookup", description: "Request data is read by the handler.", evidence: [{ path: "src/server.ts", lineStart: 1, lineEnd: 1 }] }],
  threats: [{
    title: "Credential disclosure",
    scenario: "A query string is retained in logs and exposes the password.",
    affectedAssets: ["Credentials"],
    entryPoints: ["HTTP request"],
    trustBoundaries: ["Network boundary"],
    mitigations: ["Use an authorization header"],
    severity: "high",
    evidence: [{ path: "src/server.ts", lineStart: 1, lineEnd: 1 }],
  }],
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

beforeAll(async () => {
  workspace = makeWorkspace();
  writeFileIn(workspace, "src/server.ts", "const password = request.query.password;\n");
  const createAgent = fakeAgentFactory(async function* (_options, input) {
    yield { type: "session.created", sessionId: `security-${scanCount + 1}` };
    if (input.task.includes("repository-wide security review")) {
      const content = scanCount++ === 0 ? findingEnvelope : JSON.stringify({ findings: [] });
      yield { type: "model.message", content };
    } else if (input.task.includes("Build an evidence-backed threat model")) {
      yield { type: "model.message", content: threatModelEnvelope };
    } else if (!input.task.includes("Fix security finding")) {
      throw new Error(`unexpected security agent task: ${input.task}`);
    }
    yield { type: "session.completed", report: emptyReport("security task completed") };
  });
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe("Security Center routes", () => {
  it("runs scan, lifecycle, threat model, verified fix, and compliance exports", async () => {
    const scanRes = await request("/api/security/scan", {
      method: "POST",
      body: JSON.stringify({ maxFindings: 10 }),
    });
    expect(scanRes.status).toBe(200);
    const scan = await scanRes.json() as { findings: Array<{ id: string; status: string }> };
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]!.status).toBe("open");
    const findingId = scan.findings[0]!.id;

    const triage = await request(`/api/security/findings/${findingId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "triaged", reason: "confirmed by security owner" }),
    });
    expect(triage.status).toBe(200);
    expect(await triage.json()).toMatchObject({ id: findingId, status: "triaged" });

    const threatRes = await request("/api/security/threat-model", { method: "POST", body: "{}" });
    expect(threatRes.status).toBe(200);
    expect(await threatRes.json()).toMatchObject({ summary: expect.any(String), threats: [{ severity: "high" }] });

    const fixRes = await request(`/api/security/findings/${findingId}/fix`, {
      method: "POST",
      body: JSON.stringify({ verifyCommand: "true", maxCostUsd: 1 }),
    });
    expect(fixRes.status).toBe(200);
    expect(await fixRes.json()).toMatchObject({
      fix: { status: "verified", commands: [{ kind: "verify", exitCode: 0, timedOut: false }] },
      finding: { id: findingId, status: "resolved", verificationStatus: "verified" },
    });

    const state = await (await request("/api/security")).json() as {
      findings: Array<{ id: string; status: string; verificationStatus: string }>;
      scans: unknown[];
      fixes: unknown[];
      threatModels: unknown[];
      disclaimer: string;
    };
    expect(state.findings).toContainEqual(expect.objectContaining({
      id: findingId,
      status: "resolved",
      verificationStatus: "verified",
    }));
    expect(state.scans).toHaveLength(2);
    expect(state.fixes).toHaveLength(1);
    expect(state.threatModels).toHaveLength(1);
    expect(state.disclaimer).toContain("not a certification");

    for (const format of ["json", "markdown", "sarif"]) {
      const exportRes = await request(`/api/security/export?format=${format}`);
      expect(exportRes.status).toBe(200);
      const report = await exportRes.json() as { filename: string; content: string; disclaimer: string };
      expect(report.filename).toContain("seekforge-security-report");
      expect(report.content.length).toBeGreaterThan(20);
      expect(report.disclaimer).toContain("not a certification");
    }
  });

  it("rejects invalid scan limits and lifecycle transitions", async () => {
    expect((await request("/api/security/scan", {
      method: "POST",
      body: JSON.stringify({ maxFindings: 0 }),
    })).status).toBe(400);

    const stateBeforeFix = await (await request("/api/security")).json() as { findings: Array<{ id: string }> };
    expect((await request(`/api/security/findings/${stateBeforeFix.findings[0]!.id}/fix`, {
      method: "POST",
      body: JSON.stringify({ verifyCommand: "true" }),
    })).status).toBe(400);

    const state = await (await request("/api/security")).json() as { findings: Array<{ id: string }> };
    const invalid = await request(`/api/security/findings/${state.findings[0]!.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "open" }),
    });
    expect(invalid.status).toBe(409);
  });
});
