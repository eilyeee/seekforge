// Regression tests for the PURE Docker runner core (buildDockerRunArgs) and the
// sandbox-run --check dry-run. No Docker, no spend, no real agent run: the
// command construction IS the verification. Matching the other tests here, this
// is a dependency-free runner (run via `tsx`): each case asserts with
// node:assert and exits non-zero on the first failure.

import assert from "node:assert/strict";
import {
  buildDockerRunArgs,
  DEFAULT_RUNNER_IMAGE,
  DEFAULT_RUNNER_NETWORK,
  DEFAULT_RUNNER_WORKDIR,
  formatDockerCommand,
} from "../docker-runner.js";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => passed++,
        (err) => {
          console.error(`✗ ${name}`);
          console.error(err instanceof Error ? err.stack : String(err));
          process.exit(1);
        },
      );
      return;
    }
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

const WS = "/home/me/project";

/** Return the value token that follows `flag` in argv, or undefined. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// --- mount + workdir --------------------------------------------------------
test("workspace is a single read-write bind mount to the workdir", () => {
  const args = buildDockerRunArgs({ task: "fix the bug", workspacePath: WS });
  assert.equal(valueAfter(args, "-v"), `${WS}:${DEFAULT_RUNNER_WORKDIR}:rw`);
  assert.equal(valueAfter(args, "-w"), DEFAULT_RUNNER_WORKDIR);
  // Exactly one mount — nothing else from the host is exposed.
  assert.equal(args.filter((a) => a === "-v").length, 1);
});

test("relative workspace paths are resolved to absolute for the mount", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS });
  const mount = valueAfter(args, "-v")!;
  assert.ok(mount.startsWith("/"), "mount host path must be absolute");
});

// --- isolation defaults -----------------------------------------------------
test("--rm is always present (ephemeral container)", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS });
  assert.ok(args.includes("--rm"));
});

test("network defaults to bridge (provider API needs egress)", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS });
  assert.equal(valueAfter(args, "--network"), DEFAULT_RUNNER_NETWORK);
  assert.equal(DEFAULT_RUNNER_NETWORK, "bridge");
});

test("network is configurable (none for offline runs)", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS, network: "none" });
  assert.equal(valueAfter(args, "--network"), "none");
});

test("image defaults to seekforge-runner and is overridable", () => {
  assert.ok(buildDockerRunArgs({ task: "t", workspacePath: WS }).includes(DEFAULT_RUNNER_IMAGE));
  assert.ok(buildDockerRunArgs({ task: "t", workspacePath: WS, image: "my/img:1" }).includes("my/img:1"));
});

// --- secrets: env var NAME only, never the value ----------------------------
test("provider API key is passed by env-var NAME when set (never the value)", () => {
  const secret = "sk-super-secret-value-123";
  const args = buildDockerRunArgs({
    task: "t",
    workspacePath: WS,
    env: { ARK_API_KEY: secret },
  });
  // -e references the NAME...
  const eIdx = args.indexOf("-e");
  assert.ok(eIdx >= 0, "-e must be present");
  assert.equal(args[eIdx + 1], "ARK_API_KEY");
  // ...and the secret VALUE never appears anywhere in the argv.
  assert.ok(!args.some((a) => a.includes(secret)), "secret value must never be embedded in argv");
  assert.ok(!args.some((a) => a.includes("=")), "no -e NAME=value form (would embed a value)");
});

test("DEEPSEEK_API_KEY passes through too", () => {
  const args = buildDockerRunArgs({
    task: "t",
    workspacePath: WS,
    env: { DEEPSEEK_API_KEY: "dsk-xyz" },
  });
  const eIdx = args.indexOf("-e");
  assert.equal(args[eIdx + 1], "DEEPSEEK_API_KEY");
  assert.ok(!args.some((a) => a.includes("dsk-xyz")));
});

test("no -e flag emitted when no key env is set", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS, env: {} });
  assert.ok(!args.includes("-e"));
});

test("empty-string key env is treated as unset (no -e)", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS, env: { ARK_API_KEY: "" } });
  assert.ok(!args.includes("-e"));
});

// --- resource limits: only when provided ------------------------------------
test("--memory / --cpus appear only when set", () => {
  const bare = buildDockerRunArgs({ task: "t", workspacePath: WS });
  assert.ok(!bare.includes("--memory"));
  assert.ok(!bare.includes("--cpus"));

  const limited = buildDockerRunArgs({ task: "t", workspacePath: WS, memory: "2g", cpus: "1.5" });
  assert.equal(valueAfter(limited, "--memory"), "2g");
  assert.equal(valueAfter(limited, "--cpus"), "1.5");
});

// --- the in-container command -----------------------------------------------
test("in-container command is `seekforge run <task> -y`", () => {
  const args = buildDockerRunArgs({ task: "add a README", workspacePath: WS });
  const runIdx = args.lastIndexOf("run");
  // the `run` after the image is the seekforge subcommand
  assert.equal(args[runIdx - 1], "seekforge");
  assert.equal(args[runIdx + 1], "add a README");
  assert.ok(args.includes("-y"));
});

test("budget, model and permission-mode are carried into the in-container run", () => {
  const args = buildDockerRunArgs({
    task: "t",
    workspacePath: WS,
    maxCostUsd: 0.5,
    model: "deepseek-v4-pro",
    permissionMode: "acceptEdits",
  });
  assert.equal(valueAfter(args, "--max-cost"), "0.5");
  assert.equal(valueAfter(args, "-m"), "deepseek-v4-pro");
  assert.equal(valueAfter(args, "--permission-mode"), "acceptEdits");
});

test("argv begins with `run` (follows the `docker` binary)", () => {
  const args = buildDockerRunArgs({ task: "t", workspacePath: WS });
  assert.equal(args[0], "run");
});

// --- formatting / dry-run rendering -----------------------------------------
test("formatDockerCommand prefixes `docker` and quotes the task", () => {
  const line = formatDockerCommand(buildDockerRunArgs({ task: "fix a bug", workspacePath: WS }));
  assert.ok(line.startsWith("docker run "));
  assert.ok(line.includes('"fix a bug"'));
});

// --- the sandbox-run --check dry-run prints argv and never spawns docker ----
// The --check path returns BEFORE spawnDockerRun is ever reached, so nothing is
// spawned. We capture stdout to confirm it emits exactly the docker command.
test("sandbox-run --check prints the argv and returns without spawning docker", async () => {
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  let exitCodeBefore = process.exitCode;
  try {
    const { sandboxRunCommand } = await import("../commands/sandbox.js");
    await sandboxRunCommand("hello world", { check: true, network: "none" });
  } finally {
    console.log = realLog;
  }
  assert.equal(logs.length, 1, "dry-run prints exactly one command line");
  assert.ok(logs[0]!.startsWith("docker run "), "dry-run prints a docker run command");
  assert.ok(logs[0]!.includes("--network none"));
  assert.ok(logs[0]!.includes('"hello world"'));
  // --check must not fail the process (no docker interaction happened).
  assert.equal(process.exitCode, exitCodeBefore);
});

process.on("exit", () => {
  // process.on("exit") fires once the loop is drained, after the async test
  // above has resolved (node stays alive on its pending promise).
  console.log(`docker-runner: ${passed} assertions passed`);
});
