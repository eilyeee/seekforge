import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHooks, type HookPayload } from "../../src/hooks/index.js";

describe("runHooks", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-hooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const payload = (overrides: Partial<HookPayload> = {}): HookPayload => ({
    sessionId: "s-test",
    workspace,
    ...overrides,
  });

  it("delivers the JSON payload on stdin (stage + fields) with cwd = workspace", async () => {
    const outcomes = await runHooks(
      "preToolUse",
      [{ command: "cat > received.json" }],
      payload({ toolName: "read_file", args: { path: "a.ts" }, path: "a.ts" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
    const written = JSON.parse(readFileSync(join(workspace, "received.json"), "utf8"));
    expect(written).toMatchObject({
      stage: "preToolUse",
      toolName: "read_file",
      args: { path: "a.ts" },
      path: "a.ts",
      sessionId: "s-test",
      workspace,
    });
  });

  it("exposes SEEKFORGE_HOOK_STAGE and SEEKFORGE_TOOL in the environment", async () => {
    const outcomes = await runHooks(
      "postToolUse",
      [{ command: 'echo "$SEEKFORGE_HOOK_STAGE/$SEEKFORGE_TOOL"' }],
      payload({ toolName: "apply_patch" }),
    );
    expect(outcomes[0]!.outputTail).toBe("postToolUse/apply_patch");
  });

  it("kills a hook that exceeds the timeout and reports it", async () => {
    const started = Date.now();
    const outcomes = await runHooks(
      "preToolUse",
      [{ command: "sleep 30" }],
      payload({ toolName: "run_command" }),
      { timeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.timedOut).toBe(true);
    expect(outcomes[0]!.outputTail).toContain("timed out");
  });

  it("a non-zero preToolUse hook fails with its output tail and stops later hooks", async () => {
    const outcomes = await runHooks(
      "preToolUse",
      [
        { command: "echo nope; echo really 1>&2; exit 1" },
        { command: "touch should-not-exist" },
      ],
      payload({ toolName: "run_command" }),
    );
    expect(outcomes).toHaveLength(1); // second hook skipped after the block
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.exitCode).toBe(1);
    expect(outcomes[0]!.outputTail).toContain("nope");
    expect(outcomes[0]!.outputTail).toContain("really");
    expect(existsSync(join(workspace, "should-not-exist"))).toBe(false);
  });

  it("postToolUse failures are reported but never stop later hooks", async () => {
    const errors: string[] = [];
    const outcomes = await runHooks(
      "postToolUse",
      [{ command: "echo broken 1>&2; exit 7" }, { command: "touch still-ran" }],
      payload({ toolName: "apply_patch" }),
      { onError: (m) => errors.push(m) },
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[1]!.ok).toBe(true);
    expect(existsSync(join(workspace, "still-ran"))).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exit 7");
    expect(errors[0]).toContain("broken");
  });

  it("filters by match: tool name or '*' (default '*')", async () => {
    const hooks = [
      { match: "run_command", command: "touch ran-command" },
      { match: "*", command: "touch ran-star" },
      { command: "touch ran-default" },
    ];
    const outcomes = await runHooks("preToolUse", hooks, payload({ toolName: "read_file" }));
    expect(outcomes).toHaveLength(2); // run_command entry skipped
    expect(existsSync(join(workspace, "ran-command"))).toBe(false);
    expect(existsSync(join(workspace, "ran-star"))).toBe(true);
    expect(existsSync(join(workspace, "ran-default"))).toBe(true);
  });

  it("filters by pattern: prefix on the classified command or path", async () => {
    const hooks = [{ match: "run_command", pattern: "npm", command: "touch pattern-hit" }];
    let outcomes = await runHooks(
      "preToolUse",
      hooks,
      payload({ toolName: "run_command", command: "pnpm test" }),
    );
    expect(outcomes).toHaveLength(0);
    expect(existsSync(join(workspace, "pattern-hit"))).toBe(false);

    outcomes = await runHooks(
      "preToolUse",
      hooks,
      payload({ toolName: "run_command", command: "npm run build" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(existsSync(join(workspace, "pattern-hit"))).toBe(true);
  });

  it("matches pattern against the path for fs tools", async () => {
    const hooks = [{ pattern: "src/", command: "touch path-hit" }];
    const outcomes = await runHooks(
      "postToolUse",
      hooks,
      payload({ toolName: "apply_patch", path: "src/index.ts" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(existsSync(join(workspace, "path-hit"))).toBe(true);
  });

  it("runs hooks sequentially in config order", async () => {
    await runHooks(
      "postToolUse",
      [{ command: "echo first >> order.txt" }, { command: "echo second >> order.txt" }],
      payload({ toolName: "x" }),
    );
    expect(readFileSync(join(workspace, "order.txt"), "utf8")).toBe("first\nsecond\n");
  });

  it("caps the surfaced output at a 1000-char tail", async () => {
    const outcomes = await runHooks(
      "preToolUse",
      [{ command: "head -c 5000 /dev/zero | tr '\\0' 'a'; exit 1" }],
      payload({ toolName: "x" }),
    );
    expect(outcomes[0]!.outputTail.length).toBeLessThanOrEqual(1000);
  });

  it("returns no outcomes when there are no hooks", async () => {
    expect(await runHooks("sessionEnd", undefined, payload())).toEqual([]);
    expect(await runHooks("sessionEnd", [], payload())).toEqual([]);
  });

  it("delivers the stage-specific payload fields of each new stage", async () => {
    const cases = [
      { stage: "sessionStart", extras: { task: "do it", mode: "edit", resuming: false } },
      { stage: "userPromptSubmit", extras: { task: "do it" } },
      { stage: "preCompact", extras: { reason: "auto" } },
      { stage: "stop", extras: { summary: "all done" } },
      { stage: "subagentStop", extras: { agentId: "reviewer", ok: true } },
      { stage: "notification", extras: { kind: "permission", detail: { toolName: "run_command" } } },
    ] as const;
    for (const { stage, extras } of cases) {
      const file = `${stage}.json`;
      const outcomes = await runHooks(stage, [{ command: `cat > ${file}` }], payload(extras));
      expect(outcomes[0]!.ok).toBe(true);
      const written = JSON.parse(readFileSync(join(workspace, file), "utf8"));
      expect(written).toMatchObject({ stage, sessionId: "s-test", workspace, ...extras });
    }
  });

  it("userPromptSubmit blocks like preToolUse: first failure stops later hooks", async () => {
    const outcomes = await runHooks(
      "userPromptSubmit",
      [{ command: "echo blocked-reason; exit 2" }, { command: "touch should-not-exist-prompt" }],
      payload({ task: "do it" }),
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.outputTail).toContain("blocked-reason");
    expect(existsSync(join(workspace, "should-not-exist-prompt"))).toBe(false);
  });

  it("new advisory stages never block: failures are logged, later hooks run", async () => {
    const errors: string[] = [];
    const outcomes = await runHooks(
      "notification",
      [{ command: "exit 5" }, { command: "touch notif-still-ran" }],
      payload({ kind: "question", detail: { question: "?" } }),
      { onError: (m) => errors.push(m) },
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]!.ok).toBe(true);
    expect(existsSync(join(workspace, "notif-still-ran"))).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("sessionEnd entries run without a toolName and receive the status", async () => {
    const outcomes = await runHooks(
      "sessionEnd",
      [{ command: "cat > end.json" }],
      payload({ status: "completed" }),
    );
    expect(outcomes[0]!.ok).toBe(true);
    const written = JSON.parse(readFileSync(join(workspace, "end.json"), "utf8"));
    expect(written).toMatchObject({ stage: "sessionEnd", status: "completed", sessionId: "s-test" });
  });
});
