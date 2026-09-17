const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeHostMessage } = require("../media/chat-shared.js");
const { ChatState, MAX_ITEMS, usageView } = require("../src/chat-state.cjs");

/** Every item and status the reducer produces must pass the webview's own validator. */
function assertRenderable(state) {
  const snapshot = state.snapshot();
  const reset = decodeHostMessage({
    type: "reset",
    ...snapshot,
    options: { mode: "edit", approvalMode: "confirm", includeContext: true },
  });
  assert.equal(reset.ok, true, reset.error);
}

test("streamed text appends to one item and the final message settles it", () => {
  const state = new ChatState();
  assert.deepEqual(
    state.applyEvent({ type: "model.delta", chunk: "Hel" }).map((op) => op.type),
    ["upsert"],
  );
  assert.deepEqual(state.applyEvent({ type: "model.delta", chunk: "lo" }), [{ type: "append", id: 1, text: "lo" }]);
  assert.deepEqual(state.applyEvent({ type: "model.delta", chunk: "" }), []);
  const [final] = state.applyEvent({ type: "model.message", content: "Hello!" });
  assert.deepEqual(final.item, { id: 1, kind: "assistant", text: "Hello!", streaming: false });
  // A final message with no deltas before it still shows up; an empty one does not.
  state.applyEvent({ type: "model.message", content: "Second" });
  state.applyEvent({ type: "model.message", content: "   " });
  assert.deepEqual(
    state.items.map((item) => item.text),
    ["Hello!", "Second"],
  );
  assertRenderable(state);
});

test("reasoning is its own block and ends when the answer starts", () => {
  const state = new ChatState();
  state.applyEvent({ type: "reasoning.delta", chunk: "thinking…" });
  const ops = state.applyEvent({ type: "model.delta", chunk: "Answer" });
  assert.deepEqual(
    ops.map((op) => [op.type, op.item?.kind, op.item?.streaming]),
    [
      ["upsert", "thinking", false],
      ["upsert", "assistant", true],
    ],
  );
  assertRenderable(state);
});

test("tool rows start running, complete by name, and carry live command output", () => {
  const state = new ChatState();
  state.applyEvent({ type: "model.delta", chunk: "Running tests" });
  state.applyEvent({ type: "tool.started", toolName: "run_command", args: { command: "pnpm test" } });
  assert.equal(state.items[0].streaming, false);
  const tool = state.items[1];
  assert.equal(tool.title, "run_command pnpm test");
  assert.equal(tool.status, "running");
  assert.match(tool.detail, /"command": "pnpm test"/);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  state.applyEvent({ type: "command.output", stream: "stdout", chunk: `${lines}\n` });
  assert.equal(tool.output.split("\n").length, 20);
  assert.match(tool.output, /line 29\n$/);
  state.applyEvent({ type: "tool.completed", toolName: "other_tool", result: { ok: true, data: "x" } });
  assert.equal(tool.status, "running");
  state.applyEvent({
    type: "tool.completed",
    toolName: "run_command",
    result: { ok: false, error: { code: "exit", message: "1 failed" } },
  });
  assert.equal(tool.status, "error");
  assert.equal(tool.summary, "error: 1 failed");
  assertRenderable(state);
});

test("update_plan renders as one checklist that is replaced in place", () => {
  const state = new ChatState();
  const items = [
    { step: "read", status: "done" },
    { step: "edit", status: "in_progress" },
    { step: 42, status: "done" },
    { step: "odd", status: "blocked" },
  ];
  assert.deepEqual(state.applyEvent({ type: "tool.started", toolName: "update_plan", args: { items } }), []);
  state.applyEvent({ type: "tool.completed", toolName: "update_plan", result: { ok: true, data: { items } } });
  state.applyEvent({
    type: "tool.completed",
    toolName: "update_plan",
    result: { ok: true, data: { items: [{ step: "read", status: "done" }] } },
  });
  assert.equal(state.items.length, 1);
  assert.deepEqual(state.items[0].steps, [{ step: "read", status: "done" }]);
  assert.deepEqual(
    state.applyEvent({ type: "tool.completed", toolName: "update_plan", result: { ok: false, error: {} } }),
    [],
  );
  assertRenderable(state);
});

test("file changes, notices, compaction and retries", () => {
  const state = new ChatState();
  state.applyEvent({ type: "file.changed", path: "src/a.ts" });
  state.applyEvent({ type: "file.changed", path: "src/a.ts" });
  state.applyEvent({ type: "notice", level: "warn", message: "hook said\nhi" });
  state.applyEvent({ type: "context.compacted", droppedTurns: 4, summaryTokens: 1500 });
  state.applyEvent({ type: "context.microcompacted", clearedResults: 3 });
  state.applyEvent({ type: "session.continuing", continuation: 1, maxContinuations: 2 });
  state.applyEvent({ type: "provider.retry", attempt: 1, maxAttempts: 3, delayMs: 10, reason: "429" });
  state.applyEvent({ type: "context.usage", usedTokens: 1, budgetTokens: 4, percent: 25 });
  state.applyEvent({ type: "something.new" });
  assert.deepEqual(
    state.items.map((item) => [item.kind, item.path ?? item.text]),
    [
      ["file", "src/a.ts"],
      ["notice", "hook said hi"],
      ["notice", "Context compacted: 4 turn(s) summarised in 1.5k tokens."],
      ["notice", "Context trimmed: 3 old tool result(s) cleared."],
      ["notice", "Continuing (slice 2 of 3)…"],
    ],
  );
  assert.equal(state.status.contextPercent, 25);
  assert.match(state.status.activity, /Retrying the model \(1\/3\): 429/);
  assertRenderable(state);
});

test("the footer shows the session window, never the run window", () => {
  const state = new ChatState();
  const run = { promptTokens: 10, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.001 };
  const session = { promptTokens: 100, completionTokens: 10, cacheHitTokens: 50, costUsd: 0.01 };
  state.applyEvent({ type: "usage.updated", usage: run, sessionUsage: session });
  assert.deepEqual(state.status.usage, session);
  state.applyEvent({ type: "usage.updated", usage: run });
  assert.deepEqual(state.status.usage, run);
  assert.deepEqual(state.applyEvent({ type: "usage.updated" }), []);
  assert.deepEqual(usageView({ promptTokens: -1, completionTokens: 1.5, cacheHitTokens: "x", costUsd: Number.NaN }), {
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
  });
});

test("the report item and session-level usage come from session.completed", () => {
  const state = new ChatState();
  state.applyEvent({ type: "session.created", sessionId: "s1" });
  state.applyEvent({ type: "model.delta", chunk: "partial" });
  state.applyEvent({
    type: "session.completed",
    report: {
      summary: "Fixed **it**",
      changedFiles: ["src/a.ts", 3],
      commandsRun: [],
      verification: "pnpm test passed",
      usage: { promptTokens: 5, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.1 },
      sessionUsage: { promptTokens: 50, completionTokens: 10, cacheHitTokens: 0, costUsd: 1 },
    },
  });
  assert.equal(state.status.sessionId, "s1");
  assert.equal(state.items[0].streaming, false);
  const report = state.items[1];
  assert.equal(report.kind, "report");
  assert.deepEqual(report.changedFiles, ["src/a.ts"]);
  assert.equal(report.usage.costUsd, 0.1);
  assert.equal(state.status.usage.costUsd, 1);
  state.applyEvent({ type: "session.failed", error: { code: "cancelled", message: "stopped" } });
  assert.equal(state.items[2].message, "stopped");
  assertRenderable(state);
});

test("a subagent card is matched only while it runs; a reused dispatch id is a new card", () => {
  const state = new ChatState();
  const base = { dispatchId: "ag-1", agentId: "explorer", task: "look around" };
  state.applyEvent({ type: "subagent.started", status: "running", ...base });
  state.applyEvent({ type: "subagent.step", status: "running", toolName: "read_file", ...base });
  assert.equal(state.items[0].detail, "→ read_file");
  state.applyEvent({ type: "subagent.completed", status: "done", resultSummary: "found it", ...base });
  assert.deepEqual([state.items[0].status, state.items[0].detail], ["done", "found it"]);
  // A later run restarts dispatch ids: the finished card must not be rewritten.
  state.applyEvent({ type: "subagent.started", status: "running", ...base, task: "second run" });
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].status, "done");
  state.applyEvent({ type: "subagent.failed", status: "failed", error: { message: "boom" }, ...base });
  assert.deepEqual([state.items[1].status, state.items[1].detail], ["failed", "boom"]);
  // Terminal events for an unknown dispatch are ignored; malformed ones too.
  assert.deepEqual(state.applyEvent({ type: "subagent.cancelled", status: "cancelled", ...base, dispatchId: "x" }), []);
  assert.deepEqual(state.applyEvent({ type: "subagent.started", status: "weird", ...base }), []);
  assertRenderable(state);
});

test("a long transcript keeps the newest items and asks the view to reset", () => {
  const state = new ChatState();
  let resets = 0;
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
    const ops = state.notice("info", `n${i}`);
    if (ops.some((op) => op.type === "reset")) resets += 1;
  }
  assert.equal(state.items.length, MAX_ITEMS);
  assert.equal(state.items[0].text, "n5");
  assert.equal(resets, 5);
  assertRenderable(state);
});

test("a stored transcript pairs tool calls with results inside each turn", () => {
  const state = new ChatState();
  state.loadTranscript([
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "fix the bug" },
    {
      role: "assistant",
      content: "Looking",
      toolCalls: [
        { id: "c1", name: "read_file", argumentsJson: '{"path":"src/a.ts"}' },
        { id: "c2", name: "update_plan", argumentsJson: "{}" },
        { id: "c3", name: "run_command", argumentsJson: "not json" },
      ],
    },
    { role: "tool", toolCallId: "c1", content: "file body\nmore" },
    { role: "tool", toolCallId: "c3", content: "" },
    { role: "user", content: "again" },
    // The same call id in a later turn belongs to that turn only.
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_dir", argumentsJson: "{}" }] },
    { role: "tool", toolCallId: "c1", content: "entries" },
    { role: "tool", toolCallId: "c1", content: "duplicate result is ignored" },
    null,
  ]);
  assert.deepEqual(
    state.items.map((item) => [item.kind, item.title ?? item.text, item.summary]),
    [
      ["user", "fix the bug", undefined],
      ["assistant", "Looking", undefined],
      ["tool", "read_file src/a.ts", "file body more"],
      ["tool", "run_command", "ok"],
      ["user", "again", undefined],
      ["tool", "list_dir {}", "entries"],
    ],
  );
  assertRenderable(state);
});

test("oversized fields are clipped to bounds the webview accepts", () => {
  const state = new ChatState();
  const huge = "x".repeat(500_000);
  const emoji = "😀".repeat(3_000);
  state.addUser(huge, [`selection ${"d/".repeat(400)}a.ts:1-2`]);
  state.applyEvent({ type: "reasoning.delta", chunk: huge });
  state.applyEvent({ type: "model.message", content: huge });
  state.applyEvent({ type: "tool.started", toolName: "t".repeat(500), args: { content: huge } });
  state.applyEvent({ type: "command.output", stream: "stdout", chunk: huge });
  state.applyEvent({ type: "tool.completed", toolName: "t".repeat(500), result: { ok: true, data: huge } });
  state.applyEvent({ type: "file.changed", path: `/${"p".repeat(5_000)}` });
  state.applyEvent({ type: "notice", level: "info", message: emoji });
  const agent = { dispatchId: "a", agentId: "g".repeat(300), task: emoji };
  state.applyEvent({ type: "subagent.started", status: "running", ...agent });
  state.applyEvent({ type: "subagent.completed", status: "done", resultSummary: emoji, ...agent });
  state.applyEvent({
    type: "tool.completed",
    toolName: "update_plan",
    result: { ok: true, data: { items: [{ step: "s".repeat(2_000), status: "pending" }] } },
  });
  state.applyEvent({
    type: "session.completed",
    report: { summary: huge, changedFiles: ["f".repeat(5_000)], verification: huge, usage: {} },
  });
  state.applyEvent({ type: "session.failed", error: { message: huge } });
  assert.ok(state.items.length >= 10);
  assertRenderable(state);
  // Each upsert must pass on its own, too.
  for (const item of state.items) {
    assert.equal(decodeHostMessage({ type: "upsert", item }).ok, true, item.kind);
  }
});

test("the final message replaces the turn's streamed text even after interleaved reasoning", () => {
  const state = new ChatState();
  state.applyEvent({ type: "model.delta", chunk: "Answer" });
  state.applyEvent({ type: "reasoning.delta", chunk: "late thought" });
  state.applyEvent({ type: "model.message", content: "Answer" });
  assert.deepEqual(
    state.items.map((item) => [item.kind, item.text, item.streaming]),
    [
      ["assistant", "Answer", false],
      ["thinking", "late thought", false],
    ],
  );
  // After a tool call, the next message is a new turn.
  state.applyEvent({ type: "tool.started", toolName: "read_file", args: {} });
  state.applyEvent({ type: "model.message", content: "Next turn" });
  assert.equal(state.items.at(-1).text, "Next turn");
  assert.equal(state.items.filter((item) => item.kind === "assistant").length, 2);
});

test("a session id the server would never mint is not shown", () => {
  const state = new ChatState();
  assert.deepEqual(state.applyEvent({ type: "session.created", sessionId: "../../x" }), []);
  assert.deepEqual(state.applyEvent({ type: "session.created", sessionId: "s".repeat(200) }), []);
  assert.equal(state.status.sessionId, null);
  state.applyEvent({ type: "session.created", sessionId: "20260917T083423-90d4b0c46559" });
  assert.equal(state.status.sessionId, "20260917T083423-90d4b0c46559");
});
