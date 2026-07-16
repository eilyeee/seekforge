import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSecurityEvent,
  buildSecurityState,
  changeFindingStatus,
  changeFindingVerification,
  newSecurityEventId,
  readSecurityEvents,
  securityEventsPath,
} from "../../src/security/store.js";
import type { Finding } from "../../src/security/types.js";

describe("append-only security store", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-security-store-"));
    writeFileSync(join(workspace, "app.ts"), "unsafe();\n");
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function seed(): Finding {
    const at = new Date().toISOString();
    const finding: Finding = {
      id: "sf-test",
      fingerprint: "a".repeat(64),
      title: "Unsafe call",
      description: "Unsafe call is reachable.",
      severity: "high",
      confidence: "high",
      category: "unsafe-call",
      recommendation: "Remove it.",
      evidence: [{ path: "app.ts", lineStart: 1, lineEnd: 1, excerpt: "unsafe();" }],
      source: { scanner: "test", version: "1", ruleId: "unsafe" },
      status: "open",
      verificationStatus: "unverified",
      firstSeenAt: at,
      lastSeenAt: at,
      scanRunId: "scan-1",
    };
    appendSecurityEvent(workspace, {
      version: 1,
      id: newSecurityEventId("finding"),
      at,
      type: "finding.detected",
      finding,
    });
    return finding;
  }

  it("writes JSONL with private file and directory permissions", () => {
    seed();
    const target = securityEventsPath(workspace);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(join(workspace, ".seekforge", "security")).mode & 0o777).toBe(0o700);
    expect(readSecurityEvents(workspace)).toHaveLength(1);
  });

  it("rebuilds lifecycle and independent verification state", () => {
    seed();
    changeFindingStatus(workspace, "sf-test", "triaged", "confirmed");
    changeFindingStatus(workspace, "sf-test", "fixing", "work started");
    changeFindingStatus(workspace, "sf-test", "resolved", "patched");
    changeFindingVerification(workspace, "sf-test", "verified", "rescan passed", "scan-2");
    const finding = buildSecurityState(workspace).findings.get("sf-test");
    expect(finding).toMatchObject({ status: "resolved", verificationStatus: "verified" });
    expect(readSecurityEvents(workspace)).toHaveLength(5);
  });

  it("rejects invalid transitions and tampered event bodies", () => {
    seed();
    expect(() => changeFindingStatus(workspace, "sf-test", "reopened", "bad transition")).toThrow(/invalid/);
    const target = securityEventsPath(workspace);
    writeFileSync(
      target,
      `${readFileSync(target, "utf8")}{"version":1,"id":"x","at":"2026-01-01T00:00:00.000Z","type":"finding.detected","finding":null}\n`,
    );
    expect(() => readSecurityEvents(workspace)).toThrow(/invalid security event/);
  });
});
