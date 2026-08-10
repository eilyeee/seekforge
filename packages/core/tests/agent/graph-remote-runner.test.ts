import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { graphExecutionAdapterEligibility } from "../../src/agent/graph-execution-contract.js";
import type { GraphFunctionContext } from "../../src/agent/graph-execution-contract.js";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import {
  createGraphRemoteRunnerAdapter,
  parseGraphRemoteRunEnvelope,
  type GraphRemoteRunnerCommand,
  type GraphRemoteRunnerProcessResult,
  type GraphRemoteRunnerTransport,
} from "../../src/agent/graph-remote-runner.js";
import type { GraphNode } from "../../src/agent/graph-contract.js";

const deps = {} as AgentCoreDeps;

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "did the thing",
      session_id: "20260101-abcdef",
      num_turns: 3,
      duration_ms: 1200,
      total_cost_usd: 0.25,
      usage: { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 0 },
      ...overrides,
    },
    null,
    2,
  );
}

describe("parseGraphRemoteRunEnvelope", () => {
  it("reads usage, session, and summary out of a pretty-printed envelope", () => {
    expect(parseGraphRemoteRunEnvelope(envelope())).toEqual({
      isError: false,
      summary: "did the thing",
      sessionId: "20260101-abcdef",
      costUsd: 0.25,
      tokensUsed: 1_000,
    });
  });

  it("finds the envelope after unrelated output", () => {
    const parsed = parseGraphRemoteRunEnvelope(`warming up\nsome banner\n${envelope()}\n`);
    expect(parsed?.costUsd).toBe(0.25);
  });

  it("treats an envelope with no usage block as unmeasured rather than as zero", () => {
    // `total_cost_usd` still says 0 here; only the usage block proves a measurement.
    const parsed = parseGraphRemoteRunEnvelope(envelope({ usage: {}, total_cost_usd: 0 }));
    expect(parsed).toBeDefined();
    expect(parsed?.costUsd).toBeUndefined();
    expect(parsed?.tokensUsed).toBeUndefined();
  });

  it("rejects a negative cost and a non-integer token count", () => {
    expect(parseGraphRemoteRunEnvelope(envelope({ total_cost_usd: -1 }))?.costUsd).toBeUndefined();
    expect(
      parseGraphRemoteRunEnvelope(envelope({ usage: { input_tokens: 1.5, output_tokens: 1 } }))?.costUsd,
    ).toBeUndefined();
  });

  it("returns nothing for output that carries no result envelope", () => {
    expect(parseGraphRemoteRunEnvelope("")).toBeUndefined();
    expect(parseGraphRemoteRunEnvelope("not json at all")).toBeUndefined();
    expect(parseGraphRemoteRunEnvelope(JSON.stringify({ type: "system" }))).toBeUndefined();
  });

  it("surfaces a failed run as an error envelope", () => {
    const parsed = parseGraphRemoteRunEnvelope(envelope({ is_error: true, result: "it broke" }));
    expect(parsed).toMatchObject({ isError: true, summary: "it broke" });
  });
});

type Launch = { command: GraphRemoteRunnerCommand; aborted: boolean };

function recordingSpawn(
  launches: Launch[],
  results: GraphRemoteRunnerProcessResult | ((command: GraphRemoteRunnerCommand) => GraphRemoteRunnerProcessResult),
) {
  return async (
    command: GraphRemoteRunnerCommand,
    options: { signal?: AbortSignal },
  ): Promise<GraphRemoteRunnerProcessResult> => {
    launches.push({ command, aborted: options.signal?.aborted === true });
    return typeof results === "function" ? results(command) : results;
  };
}

const node: GraphNode = { id: "remote-work", kind: "remote", executor: "runner", task: "ship it" };

function context(workspace: string, overrides: Partial<GraphFunctionContext> = {}): GraphFunctionContext {
  return {
    node,
    workspace,
    dependencies: new Map(),
    inputs: {},
    idempotencyKey: "graph:remote-work:11111111-2222-4333-8444-555555555555",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function transport(overrides: Partial<GraphRemoteRunnerTransport> = {}): GraphRemoteRunnerTransport {
  return {
    name: "fake",
    costAccount: "local",
    sessionIsLocal: false,
    command: (request) => ({
      file: "fake-runner",
      args: [
        "run",
        request.task,
        ...(request.maxCostUsd !== undefined ? ["--max-cost", String(request.maxCostUsd)] : []),
        ...(request.maxDurationSeconds !== undefined ? ["--max-duration", String(request.maxDurationSeconds)] : []),
      ],
    }),
    ...overrides,
  };
}

describe("createGraphRemoteRunnerAdapter", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-remote-runner-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("refuses a host misconfiguration before anything can run", () => {
    expect(() => createGraphRemoteRunnerAdapter("not a valid id", transport())).toThrow(/executor id is invalid/);
    expect(() => createGraphRemoteRunnerAdapter("runner", transport(), { capacity: 0 })).toThrow(/capacity/);
    expect(() => createGraphRemoteRunnerAdapter("runner", transport(), { workspaceCapacity: 513 })).toThrow(
      /workspaceCapacity/,
    );
    expect(() => createGraphRemoteRunnerAdapter("runner", transport({ name: "bad name" }))).toThrow(/transport name/);
  });

  it("passes preflight and declares only the capabilities its transport has", () => {
    const plain = createGraphRemoteRunnerAdapter("runner", transport(), { capacity: 2, workspaceCapacity: 4 });
    expect(plain).toMatchObject({ trusted: true, locality: "remote", protocolVersion: 1, capacity: 2, active: 0 });
    expect(plain.supportsCancellation).toBeUndefined();
    expect(plain.reserve).toBeUndefined();
    expect(plain.verifyResult).toBeUndefined();
    expect(graphExecutionAdapterEligibility(node, plain).status).toBe("eligible");
    // A node that requires cancellation must be refused by a transport that
    // cannot stop a dispatched attempt.
    expect(graphExecutionAdapterEligibility({ ...node, requiresCancellation: true }, plain).status).toBe(
      "cancellation_unsupported",
    );

    const full = createGraphRemoteRunnerAdapter(
      "runner",
      transport({
        sessionIsLocal: true,
        fencingToken: (request) => `container-${request.nodeId}`,
        cancelCommand: (request) => ({ file: "fake-runner", args: ["kill", request.fencingToken ?? ""] }),
      }),
    );
    expect(full.supportsCancellation).toBe(true);
    expect(graphExecutionAdapterEligibility({ ...node, requiresCancellation: true }, full).status).toBe("eligible");
  });

  it("reports the usage the run itself reported and records whose account paid", async () => {
    const root = workspace();
    const launches: Launch[] = [];
    const adapter = createGraphRemoteRunnerAdapter("runner", transport({ costAccount: "remote" }), {
      spawn: recordingSpawn(launches, { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    const result = await adapter.execute(context(root, { costBudgetUsd: 5, tokenBudget: 10_000 }));
    expect(result).toMatchObject({ costUsd: 0.25, tokensUsed: 1_000 });
    expect(result.output).toMatchObject({
      runner: "fake",
      sessionId: "20260101-abcdef",
      costAccounting: "reported",
      costAccount: "remote",
    });
    // The remaining Graph budget is pushed down so the run enforces it too.
    expect(launches[0]?.command.args).toEqual(["run", "ship it", "--max-cost", "5"]);
  });

  it("fails closed when a budgeted node comes back with no usage report", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope({ usage: {} }), stderr: "" }),
    });
    await expect(adapter.execute(context(root, { costBudgetUsd: 3 }))).rejects.toThrow(/reported no usage/);
  });

  it("marks an unbudgeted node unreported instead of pretending it cost nothing", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: "no envelope here", stderr: "" }),
    });
    const result = await adapter.execute(context(root));
    expect(result.costUsd).toBe(0);
    expect(result.output).toMatchObject({ costAccounting: "unreported", sessionId: null });
  });

  it("keeps the usage a failed run already spent", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], {
        exitCode: 2,
        stdout: envelope({ is_error: true, result: "verify failed" }),
        stderr: "",
      }),
    });
    await expect(adapter.execute(context(root))).rejects.toMatchObject({
      name: "GraphNodeExecutionError",
      usage: { costUsd: 0.25, tokensUsed: 1_000 },
    });
  });

  it("refuses a node with no task and a transport command that is not an argv", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    await expect(adapter.execute(context(root, { node: { ...node, task: "  " } }))).rejects.toThrow(/requires a task/);

    const broken = createGraphRemoteRunnerAdapter("runner", transport({ command: () => ({ file: "", args: [] }) }), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: "", stderr: "" }),
    });
    await expect(broken.execute(context(root))).rejects.toThrow(/invalid command/);
  });

  it("fences, cancels, and releases through the transport's own commands", async () => {
    const root = workspace();
    const launches: Launch[] = [];
    const adapter = createGraphRemoteRunnerAdapter(
      "runner",
      transport({
        fencingToken: (request) => `box-${request.nodeId}`,
        cancelCommand: (request) => ({ file: "fake-runner", args: ["kill", request.fencingToken ?? "none"] }),
        releaseCommand: (request) => ({ file: "fake-runner", args: ["rm", request.fencingToken ?? "none"] }),
      }),
      { spawn: recordingSpawn(launches, { exitCode: 0, stdout: envelope(), stderr: "" }) },
    );
    const reservation = await adapter.reserve!(context(root));
    expect(reservation.fencingToken).toBe("box-remote-work");
    const leased = context(root, { executorLease: { fencingToken: reservation.fencingToken } });
    await adapter.cancel!(leased);
    await reservation.release();
    expect(launches.map((launch) => launch.command.args)).toEqual([
      ["kill", "box-remote-work"],
      ["rm", "box-remote-work"],
    ]);
  });

  it("rejects a fencing token the transport cannot produce safely", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport({ fencingToken: () => "" }));
    await expect(async () => adapter.reserve!(context(root))).rejects.toThrow(/invalid fencing token/);
  });

  it("recovers a committed result for the same idempotency key and only that key", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    expect(await adapter.recover!(context(root))).toBeUndefined();
    await adapter.execute(context(root));
    expect(await adapter.recover!(context(root))).toMatchObject({ costUsd: 0.25, tokensUsed: 1_000 });
    expect(await adapter.recover!(context(root, { idempotencyKey: "graph:remote-work:other" }))).toBeUndefined();
    // A different executor id never inherits another executor's committed work.
    const other = createGraphRemoteRunnerAdapter("second", transport());
    expect(await other.recover!(context(root))).toBeUndefined();
  });

  it("verifies a local session claim and refuses one the workspace cannot back", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport({ sessionIsLocal: true }), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    const result = await adapter.execute(context(root));
    expect(await adapter.verifyResult!(result, context(root))).toBe(false);
    mkdirSync(join(root, ".seekforge", "sessions", "20260101-abcdef"), { recursive: true });
    expect(await adapter.verifyResult!(result, context(root))).toBe(true);
    expect(await adapter.verifyResult!({ output: "not a record" }, context(root))).toBe(false);
    expect(
      await adapter.verifyResult!({ output: { sessionId: null, costAccounting: "unreported" } }, context(root)),
    ).toBe(true);
  });

  it("keeps recovering after the journal outgrows its cap", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    // Backdated leftovers from earlier attempts, one more than the journal keeps.
    const directory = join(root, ".seekforge", "graph-remote-results");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 300; index++) {
      const path = join(directory, `stale-${String(index).padStart(4, "0")}.json`);
      writeFileSync(path, "{}");
      utimesSync(path, new Date(1_000_000), new Date(1_000_000 + index));
    }
    await adapter.execute(context(root));
    expect(readdirSync(directory).length).toBeLessThanOrEqual(256);
    // The freshly committed result is the one that had to survive the pruning.
    expect(await adapter.recover!(context(root))).toMatchObject({ costUsd: 0.25 });
  });

  it("ignores a journal entry another writer corrupted", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    await adapter.execute(context(root));
    const [file] = readdirSync(join(root, ".seekforge", "graph-remote-results"));
    const path = join(root, ".seekforge", "graph-remote-results", file!);
    writeFileSync(path, JSON.stringify({ version: 1, executor: "runner", costUsd: "free" }));
    expect(await adapter.recover!(context(root))).toBeUndefined();
    writeFileSync(path, "{ not json");
    expect(await adapter.recover!(context(root))).toBeUndefined();
  });

  // The default launcher: a real child process, so the capture, the exit codes,
  // and the abort path are exercised rather than mocked away.
  describe("default process launcher", () => {
    const nodeTransport = (script: string, overrides: Partial<GraphRemoteRunnerTransport> = {}) =>
      transport({ command: () => ({ file: process.execPath, args: ["-e", script] }), ...overrides });

    it("captures a real run's stdout and turns its envelope into node usage", async () => {
      const root = workspace();
      const adapter = createGraphRemoteRunnerAdapter(
        "runner",
        nodeTransport(`console.log(${JSON.stringify(envelope())})`),
      );
      const result = await adapter.execute(context(root));
      expect(result).toMatchObject({ costUsd: 0.25, tokensUsed: 1_000 });
    });

    it("reports a real non-zero exit with the tail of what the process said", async () => {
      const root = workspace();
      const adapter = createGraphRemoteRunnerAdapter(
        "runner",
        nodeTransport('console.error("boom: the runner refused"); process.exit(3)'),
      );
      await expect(adapter.execute(context(root))).rejects.toThrow(/exit 3.*boom: the runner refused/);
    });

    it("surfaces a launcher that is not installed instead of hanging", async () => {
      const root = workspace();
      const adapter = createGraphRemoteRunnerAdapter(
        "runner",
        transport({ command: () => ({ file: "seekforge-no-such-launcher", args: [] }) }),
      );
      await expect(adapter.execute(context(root))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses to launch once the node has already been cancelled", async () => {
      const root = workspace();
      const controller = new AbortController();
      controller.abort();
      const adapter = createGraphRemoteRunnerAdapter("runner", nodeTransport("console.log(1)"));
      await expect(adapter.execute(context(root, { signal: controller.signal }))).rejects.toThrow(/cancelled/);
    });

    it("reaps a running launcher when the node is cancelled mid-flight", async () => {
      const root = workspace();
      const controller = new AbortController();
      const adapter = createGraphRemoteRunnerAdapter("runner", nodeTransport("setTimeout(() => {}, 60000)"));
      const running = adapter.execute(context(root, { signal: controller.signal }));
      setTimeout(() => controller.abort(), 50);
      // A killed launcher is a failed attempt, not a silent success.
      await expect(running).rejects.toThrow(/run failed/);
    });
  });

  it("runs a remote node end to end inside a Graph and charges what it reported", async () => {
    const root = workspace();
    const launches: Launch[] = [];
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      workspaceCapacity: 2,
      spawn: recordingSpawn(launches, { exitCode: 0, stdout: envelope(), stderr: "" }),
    });
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "remote-graph",
        costBudgetUsd: 5,
        nodes: [{ id: "build", kind: "remote", executor: "runner", task: "ship it", timeoutMs: 120_000 }],
      },
      { workspace: root, executors: { runner: adapter } },
    );
    expect(state.status).toBe("passed");
    expect(state.spentCost).toBeCloseTo(0.25);
    expect(state.spentTokens).toBe(1_000);
    expect(state.results[0]?.output).toMatchObject({ runner: "fake", costAccounting: "reported" });
    expect(launches[0]?.command.args).toEqual(["run", "ship it", "--max-cost", "5", "--max-duration", "120"]);
  });

  it("stops a Graph whose remote node cannot account for what it spent", async () => {
    const root = workspace();
    const adapter = createGraphRemoteRunnerAdapter("runner", transport(), {
      spawn: recordingSpawn([], { exitCode: 0, stdout: envelope({ usage: {} }), stderr: "" }),
    });
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "unaccountable-graph",
        costBudgetUsd: 5,
        nodes: [{ id: "build", kind: "remote", executor: "runner", task: "ship it" }],
      },
      { workspace: root, executors: { runner: adapter } },
    );
    expect(state.status).toBe("failed");
    expect(state.results[0]?.error).toMatch(/reported no usage/);
  });
});
