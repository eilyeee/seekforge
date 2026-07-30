import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planEngineeringGraphArtifactReuse } from "../../src/agent/graph-artifact-catalog.js";
import {
  materializeEngineeringGraphArtifact,
  pruneEngineeringGraphArtifactStore,
  storeEngineeringGraphArtifact,
} from "../../src/agent/graph-artifact-store.js";
import type { EngineeringGraphRunSnapshot } from "../../src/agent/graph-run-history.js";
import { archiveEngineeringGraphRun, readEngineeringGraphRunSnapshots } from "../../src/agent/graph-run-history.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";

const state: EngineeringGraphState = {
  schemaVersion: 2,
  graphId: "reuse",
  fingerprint: "a".repeat(64),
  status: "paused",
  definition: {
    graphId: "reuse",
    nodes: [
      { id: "build", kind: "function", handler: "build" },
      { id: "docs", kind: "function", handler: "docs" },
    ],
  },
  results: [
    {
      id: "docs",
      kind: "function",
      status: "passed",
      attempts: 1,
      costUsd: 0,
      tokensUsed: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  events: [],
  spentCost: 0,
  spentTokens: 0,
  elapsedMs: 1_000,
  activeAttempts: [],
  controlSeq: 0,
  controlRunId: "run",
  priority: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const run = (fingerprint = state.fingerprint): EngineeringGraphRunSnapshot => ({
  runNumber: 1,
  graphId: "reuse",
  fingerprint,
  status: "passed",
  spentCost: 0,
  spentTokens: 0,
  elapsedMs: 1_000,
  createdAt: "2025-12-31T00:00:00.000Z",
  completedAt: "2025-12-31T00:00:01.000Z",
  results: [
    {
      id: "build",
      status: "passed",
      costUsd: 0,
      tokensUsed: 0,
      artifacts: [
        {
          name: "bundle",
          path: "dist/bundle.js",
          sha256: "b".repeat(64),
          sizeBytes: 42,
          verified: true,
          producerNodeId: "build",
        },
      ],
    },
    {
      id: "docs",
      status: "passed",
      costUsd: 0,
      tokensUsed: 0,
      artifacts: [
        {
          name: "docs",
          path: "dist/docs.html",
          sha256: "c".repeat(64),
          sizeBytes: 10,
          verified: true,
          producerNodeId: "docs",
        },
      ],
    },
  ],
});

describe("Engineering Graph artifact reuse", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });
  it("offers only verified artifacts from the exact contract generation and unsettled nodes", () => {
    expect(planEngineeringGraphArtifactReuse(state, [run("f".repeat(64)), run()])).toEqual([
      expect.objectContaining({
        nodeId: "build",
        key: `sha256:${"b".repeat(64)}`,
        sourceRunNumber: 1,
      }),
    ]);
  });

  it("archives only artifacts with complete verified evidence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-artifact-archive-"));
    workspaces.push(workspace);
    archiveEngineeringGraphRun(workspace, {
      ...state,
      status: "passed",
      completedAt: "2026-01-01T00:00:02.000Z",
      results: [
        {
          id: "build",
          kind: "function",
          status: "passed",
          attempts: 1,
          costUsd: 0,
          tokensUsed: 0,
          artifacts: [
            { name: "incomplete", path: "dist/incomplete.js", verified: true },
            {
              name: "bundle",
              path: "dist/bundle.js",
              sha256: "b".repeat(64),
              sizeBytes: 42,
              verified: true,
              producerNodeId: "build",
            },
          ],
        },
      ],
    });
    expect(readEngineeringGraphRunSnapshots(workspace, state.graphId)[0]?.results[0]?.artifacts).toEqual([
      expect.objectContaining({ name: "bundle", sizeBytes: 42, verified: true }),
    ]);
  });

  it("stores, verifies, discovers, and atomically materializes CAS artifacts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-artifact-cas-"));
    workspaces.push(workspace);
    mkdirSync(join(workspace, "dist"));
    const content = Buffer.from("verified bundle\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const source = join(workspace, "dist", "bundle.js");
    writeFileSync(source, content);
    const external = join(mkdtempSync(join(tmpdir(), "seekforge-artifact-external-")), "secret.txt");
    workspaces.push(dirname(external));
    writeFileSync(external, content);
    expect(() => storeEngineeringGraphArtifact(workspace, external, digest, content.length)).toThrow(/escapes/);
    storeEngineeringGraphArtifact(workspace, source, digest, content.length);
    const archived = run();
    archived.results[0]!.artifacts = [
      {
        name: "bundle",
        path: "dist/bundle.js",
        sha256: digest,
        sizeBytes: content.length,
        verified: true,
        producerNodeId: "build",
      },
    ];
    expect(planEngineeringGraphArtifactReuse(state, [archived], workspace)[0]).toMatchObject({ casAvailable: true });
    const materialized = materializeEngineeringGraphArtifact(workspace, digest, content.length, "restored/bundle.js");
    expect(materialized.sha256).toBe(digest);
    expect(readFileSync(join(workspace, "restored", "bundle.js"))).toEqual(content);
    expect(() => materializeEngineeringGraphArtifact(workspace, digest, content.length, "restored/bundle.js")).toThrow(
      /already exists/,
    );
    expect(pruneEngineeringGraphArtifactStore(workspace, { maxAgeDays: 0, dryRun: true }).candidates).toEqual([]);
    const afterPublicationGrace = new Date(Date.now() + 10 * 60_000);
    expect(
      pruneEngineeringGraphArtifactStore(workspace, { maxAgeDays: 0, dryRun: true, now: afterPublicationGrace })
        .candidates,
    ).toEqual([digest]);
    expect(
      pruneEngineeringGraphArtifactStore(workspace, { maxAgeDays: 0, now: afterPublicationGrace }).removed,
    ).toEqual([digest]);
  });
});
