/**
 * Host registration of Graph `remote` executors, and the two transports it can
 * build. Nothing here spawns Docker or ssh: what has to be right is WHO may
 * grant trust and WHAT argv the adapter would run, and both are pure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPH_CONTAINER_PREFIX, dockerGraphTransport } from "../docker-runner.js";
import { sshGraphTransport } from "../ssh-runner.js";
import { loadGraphExecutionRegistry, loadRegisteredGraphExecutors } from "../graph-executors.js";

const roots: string[] = [];
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "seekforge-graph-executors-"));
  roots.push(root);
  return root;
}
function registry(contents: unknown): string {
  const file = join(workspace(), "graph-executors.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const request = {
  nodeId: "build",
  task: "fix the login bug",
  workspace: "/home/me/project",
  idempotencyKey: "graph:build:11111111-2222-4333-8444-555555555555",
  maxCostUsd: 2.5,
  maxDurationSeconds: 900,
};

describe("Graph executor registration", () => {
  it("registers nothing when the operator wrote no registration file", () => {
    expect(loadRegisteredGraphExecutors(join(workspace(), "absent.json"))).toEqual({});
  });

  it("refuses a malformed registry instead of quietly registering nothing", () => {
    expect(() => loadRegisteredGraphExecutors(registry("{not json"))).toThrow(/not valid JSON/);
    expect(() => loadRegisteredGraphExecutors(registry({ executors: {} }))).toThrow(/version/);
    expect(() => loadRegisteredGraphExecutors(registry({ version: 1, executors: { "bad id": {} } }))).toThrow(
      /executor id is invalid/,
    );
    expect(() =>
      loadRegisteredGraphExecutors(registry({ version: 1, executors: { sandbox: { runner: "carrier-pigeon" } } })),
    ).toThrow(/runner must be docker or ssh/);
    expect(() =>
      loadRegisteredGraphExecutors(registry({ version: 1, executors: { box: { runner: "ssh", host: "me@box" } } })),
    ).toThrow(/workspace is required/);
    expect(() =>
      loadRegisteredGraphExecutors(
        registry({ version: 1, executors: { sandbox: { runner: "docker", workspaceCapacity: 999 } } }),
      ),
    ).toThrow(/workspaceCapacity must be an integer from 1 to 512/);
  });

  it("refuses an ssh registration whose remote workspace is not absolute", () => {
    expect(() =>
      loadRegisteredGraphExecutors(
        registry({ version: 1, executors: { box: { runner: "ssh", host: "me@box", workspace: "relative/path" } } }),
      ),
    ).toThrow(/absolute remote workspace/);
  });

  it("builds trusted adapters whose declared capabilities match the transport", () => {
    const executors = loadRegisteredGraphExecutors(
      registry({
        version: 1,
        executors: {
          sandbox: { runner: "docker", image: "seekforge-runner", workspaceCapacity: 2, capacity: 3 },
          workstation: { runner: "ssh", host: "me@box", workspace: "/srv/repo" },
        },
      }),
    );
    expect(executors.sandbox).toMatchObject({
      trusted: true,
      locality: "remote",
      protocolVersion: 1,
      supportsCancellation: true,
      workspaceCapacity: 2,
      capacity: 3,
    });
    expect(executors.sandbox?.reserve).toBeTypeOf("function");
    expect(executors.sandbox?.verifyResult).toBeTypeOf("function");
    // ssh can neither fence a duplicate attempt nor stop a dispatched one, so it
    // declares neither, and preflight will reject nodes that require them.
    expect(executors.workstation).toMatchObject({ trusted: true, locality: "remote" });
    expect(executors.workstation?.supportsCancellation).toBeUndefined();
    expect(executors.workstation?.reserve).toBeUndefined();
    expect(executors.workstation?.verifyResult).toBeUndefined();
  });

  it("exposes exactly the ids the operator registered, and no plugin-invented one", () => {
    const file = registry({ version: 1, executors: { sandbox: { runner: "docker" } } });
    expect(Object.keys(loadGraphExecutionRegistry(workspace(), file))).toEqual(["sandbox"]);
  });
});

describe("docker Graph transport", () => {
  it("names the container after the attempt so the daemon itself is the fence", () => {
    const transport = dockerGraphTransport();
    const token = transport.fencingToken!(request);
    expect(token).toMatch(new RegExp(`^${GRAPH_CONTAINER_PREFIX}[0-9a-f]{32}$`));
    // Deterministic: a resumed attempt with the same key aims at the same name.
    expect(transport.fencingToken!(request)).toBe(token);
    expect(transport.fencingToken!({ ...request, idempotencyKey: "graph:build:other" })).not.toBe(token);
    expect(transport.cancelCommand!({ ...request, fencingToken: token })).toEqual({
      file: "docker",
      args: ["kill", token],
    });
    expect(transport.releaseCommand!({ ...request, fencingToken: token })).toEqual({
      file: "docker",
      args: ["rm", "-f", token],
    });
  });

  it("asks the containerized run for the JSON envelope and pushes the budget down", () => {
    const token = "seekforge-graph-deadbeef";
    const { file, args } = dockerGraphTransport({ image: "custom", network: "none" }).command({
      ...request,
      fencingToken: token,
    });
    expect(file).toBe("docker");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--name") + 1]).toBe(token);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("-v") + 1]).toBe("/home/me/project:/workspace:rw");
    expect(args[args.indexOf("--max-cost") + 1]).toBe("2.5");
    expect(args[args.indexOf("--max-duration") + 1]).toBe("900");
    expect(args).toContain("custom");
  });

  it("says the money is local, because the container inherits this machine's key", () => {
    expect(dockerGraphTransport()).toMatchObject({ name: "docker", costAccount: "local", sessionIsLocal: true });
  });
});

describe("ssh Graph transport", () => {
  it("rejects a host or remote path the operator got wrong at construction time", () => {
    expect(() => sshGraphTransport({ host: "  ", workspacePath: "/srv/repo" })).toThrow(/requires a host/);
    expect(() => sshGraphTransport({ host: "me@box", workspacePath: "srv/repo" })).toThrow(/absolute remote/);
  });

  it("asks the remote run for the JSON envelope, quoted for that host's shell", () => {
    const { file, args } = sshGraphTransport({ host: "me@box", workspacePath: "/srv/repo", port: 2222 }).command(
      request,
    );
    expect(file).toBe("ssh");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    const remote = args[args.length - 1]!;
    expect(remote).toContain("--output-format 'json'");
    expect(remote).toContain("--max-cost '2.5'");
    expect(remote).toContain("--max-duration '900'");
    expect(remote).toContain("'fix the login bug'");
    expect(args).toContain("BatchMode=yes");
  });

  it("records that the dollars are billed on the remote host's own account", () => {
    expect(sshGraphTransport({ host: "me@box", workspacePath: "/srv/repo" })).toMatchObject({
      name: "ssh",
      costAccount: "remote",
      sessionIsLocal: false,
    });
  });
});
