const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  MAX_LOOP_HISTORY_ENTRIES,
  MAX_LOOP_HISTORY_ROWS,
  SeekForgeBridge,
  formatAgentEvent,
  formatLoopEvent,
  formatLoopReport,
  formatTranscript,
  hasDiffPreview,
  loopCost,
  loopOutcome,
  loopProgress,
  loopRow,
  normalizeServerUrl,
  permissionHunkItems,
  describeRule,
  permissionSummary,
  readStoredToken,
  taskWithEditorContext,
  usageSummary,
  websocketUrl,
  withWorkspace,
  writeStoredToken,
  workspaceRootForEditor,
} = require("../src/bridge.cjs");

test("builds an authenticated websocket URL without preserving unrelated query state", () => {
  assert.equal(websocketUrl("https://agent.example/base/", "a b"), "wss://agent.example/base/ws?token=a%20b");
  assert.equal(websocketUrl("http://127.0.0.1:3847", ""), "ws://127.0.0.1:3847/ws");
});

test("rejects non-HTTP server URLs and normalizes trailing state", () => {
  assert.equal(normalizeServerUrl("https://agent.example/base///?old=1#hash"), "https://agent.example/base");
  assert.throws(() => normalizeServerUrl("file:///tmp/socket"), /http or https/);
  assert.throws(() => normalizeServerUrl("https://user:secret@agent.example/base"), /must not include credentials/);
});

test("adds a workspace id safely", () => {
  assert.equal(withWorkspace("/api/diff", "ws / one"), "/api/diff?ws=ws%20%2F%20one");
});

test("selects the active editor's workspace in a multi-root window", () => {
  const first = { uri: { fsPath: "/repo/first" } };
  const second = { uri: { fsPath: "/repo/second" } };
  const activeUri = { fsPath: "/repo/second/src/app.ts" };
  const workspaceApi = {
    workspaceFolders: [first, second],
    getWorkspaceFolder: (uri) => (uri === activeUri ? second : undefined),
  };

  assert.equal(workspaceRootForEditor(workspaceApi, { document: { uri: activeUri } }), "/repo/second");
  assert.equal(workspaceRootForEditor(workspaceApi, undefined), "/repo/first");
});

test("fails closed when the server does not host the selected workspace", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ workspaces: [{ id: "first", path: "/repo/first" }] }), { status: 200 });
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "", WebSocketImpl: class {}, fetchImpl });

  await assert.rejects(bridge.workspaceId("/repo/second"), /does not host the VS Code workspace/);
  assert.equal(await bridge.workspaceId("/repo/first/"), "first");
});

test("includes only active files inside the workspace", () => {
  const editor = {
    document: { uri: { fsPath: "/repo/src/app.ts" }, getText: () => "const selected = true;" },
    selection: {},
  };
  assert.match(taskWithEditorContext("review", editor, "/repo"), /@src\/app\.ts/);
  assert.equal(taskWithEditorContext("review", editor, "/other"), "review");
});

test("permission prompts surface raw commands and paths, and route diffs to a document", () => {
  const request = {
    description: "run a command",
    command: "npm test",
    path: "/repo/package.json",
    preview: { diff: "+changed" },
  };
  const detail = permissionSummary(request);
  assert.match(detail, /Raw command:\nnpm test/);
  assert.match(detail, /Raw path:\n\/repo\/package.json/);
  // The diff is opened as a document, so it must not be inlined into the modal.
  assert.doesNotMatch(detail, /\+changed/);
  assert.equal(hasDiffPreview(request), true);
  assert.equal(hasDiffPreview({ description: "read a file" }), false);
  assert.equal(hasDiffPreview({ description: "empty", preview: { diff: "" } }), false);
});

test("offers per-hunk selection only for genuinely multi-hunk edits", () => {
  assert.deepEqual(permissionHunkItems({ hunks: [{ index: 0, preview: "only" }] }), []);
  assert.deepEqual(permissionHunkItems({}), []);
  const items = permissionHunkItems({
    hunks: [
      { index: 0, preview: "-  a\n+  b" },
      { index: 1, preview: "-  c\n+  d" },
    ],
  });
  assert.deepEqual(
    items.map((item) => [item.label, item.index, item.picked]),
    [
      ["Hunk 1", 0, true],
      ["Hunk 2", 1, true],
    ],
  );
  assert.equal(items[0].detail, "- a + b");
});

test("renders tool activity, subagents, and failures as single output rows", () => {
  assert.equal(
    formatAgentEvent({ type: "tool.started", toolName: "run_command", args: { command: "npm test" } }),
    "⏺ run_command(npm test)",
  );
  assert.equal(
    formatAgentEvent({ type: "tool.completed", toolName: "run_command", result: { ok: true, data: "2 passed" } }),
    "  ⎿ 2 passed",
  );
  assert.equal(
    formatAgentEvent({
      type: "tool.completed",
      toolName: "apply_patch",
      result: { ok: false, error: { code: "e", message: "no match" } },
    }),
    "  ⎿ error: no match",
  );
  assert.equal(formatAgentEvent({ type: "file.changed", path: "src/app.ts" }), "  ± src/app.ts");
  assert.equal(
    formatAgentEvent({
      type: "subagent.completed",
      agentId: "explorer",
      dispatchId: "d",
      task: "t",
      status: "done",
      resultSummary: "found it",
    }),
    "  ⎿ subagent explorer done: found it",
  );
  assert.equal(formatAgentEvent({ type: "model.delta", chunk: "x" }), null);
  assert.equal(formatAgentEvent(undefined), null);
});

test("clips long tool arguments without severing surrogate pairs", () => {
  const line = formatAgentEvent({ type: "tool.started", toolName: "search_text", args: { pattern: "🙂".repeat(200) } });
  // 160 code points plus the ellipsis, never a lone surrogate half.
  assert.equal(Array.from(line).filter((character) => character === "🙂").length, 160);
  assert.match(line, /…\)$/);
});

test("reports cost first and marks cache hits in the usage readout", () => {
  assert.equal(
    usageSummary({ promptTokens: 12_500, completionTokens: 800, cacheHitTokens: 3_100, costUsd: 0.004242 }),
    "$0.0042 · 12.5k prompt (3.1k cached) · 800 completion",
  );
  assert.equal(
    usageSummary({ promptTokens: 10, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }),
    "$0.0000 · 10 prompt · 0 completion",
  );
  assert.equal(usageSummary(undefined), "");
});

test("migrates legacy tokens to SecretStorage and supports clearing", async () => {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    store: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };

  assert.equal(await readStoredToken(storage, "legacy-token"), "legacy-token");
  assert.equal(values.get("seekforge.token"), "legacy-token");
  await writeStoredToken(storage, "new-token");
  assert.equal(await readStoredToken(storage, "ignored"), "new-token");
  await writeStoredToken(storage, "");
  assert.equal(await readStoredToken(storage), "");
});

test("bounds REST calls with an aborting timeout", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  const bridge = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "",
    WebSocketImpl: class {},
    fetchImpl,
    requestTimeoutMs: 5,
  });

  await assert.rejects(bridge.request("/api/health"), (error) => error.name === "AbortError");
});

test("cancelling an active run sends cancel before closing the socket", async () => {
  class FakeSocket extends EventEmitter {
    static instance;
    sent = [];

    constructor() {
      super();
      FakeSocket.instance = this;
      queueMicrotask(() => this.emit("open"));
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.emit("close");
    }
  }

  const controller = new AbortController();
  const bridge = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "",
    WebSocketImpl: FakeSocket,
    runTimeoutMs: 1_000,
  });
  const running = bridge.run({ type: "start", task: "x" }, async () => {}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, (error) => error.name === "AbortError");
  assert.deepEqual(FakeSocket.instance.sent, [{ type: "start", task: "x" }, { type: "cancel" }]);
});

test("lists only the memory candidates still awaiting a decision", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, "http://localhost/api/memory?ws=repo");
    return new Response(
      JSON.stringify({
        candidates: [
          { id: "a", text: "uses vitest", status: "pending" },
          { id: "b", text: "old fact", status: "approved" },
          { id: "c", text: "another", status: "pending" },
        ],
      }),
      { status: 200 },
    );
  };
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "", WebSocketImpl: class {}, fetchImpl });

  const pending = await bridge.pendingMemory("repo");
  assert.deepEqual(
    pending.map((candidate) => candidate.id),
    ["a", "c"],
  );
});

test("posts a memory decision to the workspace it belongs to", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method });
    return new Response(JSON.stringify({ id: "a b", status: "approved" }), { status: 200 });
  };
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  await bridge.decideMemory("repo", "a b", "approve");
  // The id is user data that reaches a URL path — encoded, not interpolated raw.
  assert.deepEqual(seen, [{ url: "http://localhost/api/memory/a%20b/approve?ws=repo", method: "POST" }]);
  await assert.rejects(bridge.decideMemory("repo", "a", "delete"), /Unknown memory decision/);
});

test("renders a transcript for reading rather than replay", () => {
  const out = formatTranscript({ id: "s1", title: "Fix the login bug", createdAt: "2026-08-04T00:00:00Z" }, [
    { role: "system", content: "SYSTEM PROMPT THAT SHOULD NOT APPEAR" },
    { role: "user", content: "the button does nothing" },
    { role: "assistant", content: "checking", toolCalls: [{ id: "c1", name: "read_file" }] },
    { role: "tool", content: "…file…", toolCallId: "c1", images: [{ label: "shot.png" }] },
  ]);

  assert.match(out, /# Fix the login bug/);
  assert.doesNotMatch(out, /SYSTEM PROMPT/);
  assert.match(out, /## user/);
  assert.match(out, /called `read_file`/);
  // An attachment the reader cannot see still has to be visible AS an omission:
  // the model saw something this transcript does not show.
  assert.match(out, /image attached: shot\.png/);
});

test("the always-allow rule is in the modal detail, verbatim, and only when core proposed one", () => {
  const withoutRule = permissionSummary({ description: "Run a command", command: "pnpm test" });
  assert.doesNotMatch(withoutRule, /Always-allow rule/);

  const withRule = permissionSummary({
    description: "Run a command",
    command: "pnpm test",
    rememberRule: { action: "allow", tool: "run_command", match: "pnpm test" },
  });
  // The approver sees exactly what would be written — not a description of it.
  assert.match(withRule, /Always-allow rule:\nallow run_command: pnpm test/);
});

test("a rule with no match reads as the whole-tool grant it is", () => {
  assert.equal(describeRule({ action: "allow", tool: "web_search" }), "allow web_search");
});

const loopFixture = {
  loopId: "loop-1",
  task: "make the suite green",
  status: "running",
  phase: "verification",
  verifyCommand: "pnpm test",
  iterations: 3,
  maxIterations: 10,
  costUsd: 0.5,
  costBudgetUsd: 2,
  tokensUsed: 12_000,
  verifyRuns: 4,
  elapsedMs: 754_000,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T00:12:34Z",
  lastVerify: { code: 1, output: "line1\nline2\n" },
};

test("classifies every persisted loop status, and never invents a pass", () => {
  assert.equal(loopOutcome("running"), "active");
  assert.equal(loopOutcome("paused"), "active");
  assert.equal(loopOutcome("passed"), "pass");
  assert.equal(loopOutcome("cancelled"), "cancelled");
  assert.equal(loopOutcome("requirements_pending"), "pending");
  for (const status of ["exhausted", "no_progress", "budget", "verify_error", "agent_error", "interrupted"]) {
    assert.equal(loopOutcome(status), "fail");
  }
  // A status this client has never heard of is not a success.
  assert.equal(loopOutcome("something_new"), "fail");
});

test("a loop row shows status, iteration progress and spend against the budget", () => {
  const row = loopRow(loopFixture);
  assert.equal(row.loopId, "loop-1");
  assert.equal(row.outcome, "active");
  assert.equal(row.label, "make the suite green");
  assert.equal(row.description, "running · 3/10 · $0.5000 / $2.0000");
  assert.match(row.detail, /loop-1 · phase verification · updated /);
});

test("an unbudgeted or malformed loop still renders without inventing numbers", () => {
  assert.equal(loopCost({ costUsd: 0.25, costBudgetUsd: null }), "$0.2500");
  assert.equal(loopProgress({ iterations: 2, maxIterations: 0 }), "2");
  const row = loopRow({});
  assert.equal(row.loopId, "");
  assert.equal(row.label, "loop");
  assert.equal(row.description, "unknown · 0 · $0.0000");
  assert.equal(row.detail, "");
});

test("formats loop history entries, including event types this client predates", () => {
  assert.equal(formatLoopEvent({ type: "iteration.start", iteration: 2 }), "iteration 2 started");
  assert.equal(
    formatLoopEvent({ type: "verify", iteration: 2, code: 1, passed: false }),
    "iteration 2 verify exit 1 — failed",
  );
  assert.equal(
    formatLoopEvent({ type: "loop.done", result: { status: "passed", iterations: 4, costUsd: 1.5 } }),
    "done — passed after 4 iteration(s), $1.5000",
  );
  // Unknown rows are named, not dropped: a silently shortened history would
  // misrepresent what the loop did.
  assert.equal(formatLoopEvent({ type: "loop.something.new", iteration: 9 }), "loop.something.new");
  assert.equal(formatLoopEvent(null), "unknown event");
});

test("renders a loop report with its progress, spend and retained history", () => {
  const report = formatLoopReport(loopFixture, [
    { seq: 1, ts: "2026-08-10T00:01:00Z", event: { type: "iteration.start", iteration: 1 } },
    { seq: 2, ts: "2026-08-10T00:02:00Z", event: { type: "verify", iteration: 1, code: 1, passed: false } },
  ]);

  assert.match(report, /# make the suite green/);
  assert.match(report, /\*\*Status\*\*: running \(phase verification\)/);
  assert.match(report, /\*\*Iterations\*\*: 3\/10/);
  assert.match(report, /\*\*Cost\*\*: \$0\.5000 \/ \$2\.0000/);
  assert.match(report, /\*\*Elapsed\*\*: 12m34s/);
  assert.match(report, /## Verify command\n\n```sh\npnpm test\n```/);
  assert.match(report, /## Last verify \(exit 1\)/);
  assert.match(report, /`2` 2026-08-10T00:02:00Z — iteration 1 verify exit 1 — failed/);
});

test("a verify command or output containing a fence cannot break out of its block", () => {
  const report = formatLoopReport(
    {
      loopId: "loop-3",
      status: "verify_error",
      verifyCommand: "printf '```'",
      lastVerify: { code: 2, output: "```\n# NOT A HEADING\n```" },
    },
    [],
  );

  // The body stays inside a longer fence, so injected markdown is still text.
  assert.match(report, /````sh\nprintf '```'\n````/);
  assert.match(report, /````txt\n```\n# NOT A HEADING\n```\n````/);
});

test("says so when a loop has no retained history rather than rendering an empty section", () => {
  assert.match(formatLoopReport({ loopId: "loop-2", status: "passed" }, []), /_No retained history for this loop\._/);
});

test("an unreadable history is reported as unreadable, not as a loop that has none", () => {
  const failed = formatLoopReport({ loopId: "loop-2" }, [], { error: new Error("SeekForge HTTP 404") });
  assert.match(failed, /_History could not be read: SeekForge HTTP 404\._/);
  assert.doesNotMatch(failed, /No retained history/);
});

test("lists loops for a workspace and tolerates a body that is not an array", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(url.includes("/api/loops") ? [loopFixture] : {}), { status: 200 });
  };
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  assert.deepEqual(await bridge.loops("repo"), [loopFixture]);
  assert.deepEqual(seen, ["http://localhost/api/loops?ws=repo"]);

  const notArray = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "t",
    WebSocketImpl: class {},
    fetchImpl: async () => new Response(JSON.stringify({ loops: [] }), { status: 200 }),
  });
  assert.deepEqual(await notArray.loops("repo"), []);
});

test("reads one loop and its history under a bounded, encoded query", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(url.includes("/history") ? [] : loopFixture), { status: 200 });
  };
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  await bridge.loop("repo", "a b");
  await bridge.loopHistory("repo", "a b", { after: 7 });
  assert.deepEqual(seen, [
    "http://localhost/api/loops/a%20b?ws=repo",
    // The server rejects a limit above 1000, so the default must stay under it.
    `http://localhost/api/loops/a%20b/history?after=7&limit=${MAX_LOOP_HISTORY_ENTRIES}&ws=repo`,
  ]);
  assert.ok(MAX_LOOP_HISTORY_ENTRIES <= 1000);
});

/** A server whose history pages forward from `after`, exactly like the real one. */
function historyServer(total) {
  const all = Array.from({ length: total }, (_, index) => ({
    seq: index + 1,
    ts: "2026-08-10T00:00:00Z",
    event: { type: "iteration.start", iteration: index + 1 },
  }));
  const requests = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const after = Number(params.get("after"));
    requests.push(after);
    // Exactly the server's contract: entries with seq > after, at most `limit`.
    const page = all.filter((entry) => entry.seq > after).slice(0, Number(params.get("limit")));
    return new Response(JSON.stringify(page), { status: 200 });
  };
  return { requests, fetchImpl };
}

test("reads the most recent history rather than the first page of a long loop", async () => {
  const total = MAX_LOOP_HISTORY_ENTRIES * 3 + 7;
  const { requests, fetchImpl } = historyServer(total);
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  const { entries, dropped, truncated } = await bridge.loopHistoryTail("repo", "loop-1");
  // The tail is what a reader opens a finished loop for; the first page is not.
  assert.equal(entries.length, MAX_LOOP_HISTORY_ROWS);
  assert.equal(entries[entries.length - 1].seq, total);
  assert.equal(dropped, total - MAX_LOOP_HISTORY_ROWS);
  assert.equal(truncated, false);
  // Each page advanced the cursor to the last seq it returned.
  assert.deepEqual(requests, [0, MAX_LOOP_HISTORY_ENTRIES, MAX_LOOP_HISTORY_ENTRIES * 2, MAX_LOOP_HISTORY_ENTRIES * 3]);
});

test("a custom page size stays coherent with the end-of-log test", async () => {
  // 40 entries in pages of 10: the fourth page is full, the fifth is empty —
  // a client that compared against the default page size would stop at page 1.
  const { requests, fetchImpl } = historyServer(40);
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  const { entries, truncated } = await bridge.loopHistoryTail("repo", "l", { limit: 10, rows: 5 });
  assert.deepEqual(requests, [0, 10, 20, 30, 40]);
  assert.equal(entries[entries.length - 1].seq, 40);
  assert.equal(truncated, false);
});

test("stops paging at the page cap and at a cursor that does not advance", async () => {
  const { requests, fetchImpl } = historyServer(MAX_LOOP_HISTORY_ENTRIES * 4);
  const bridge = new SeekForgeBridge({ serverUrl: "http://localhost", token: "t", WebSocketImpl: class {}, fetchImpl });

  const capped = await bridge.loopHistoryTail("repo", "loop-1", { maxPages: 2 });
  assert.equal(capped.truncated, true);
  assert.equal(requests.length, 2);

  // A server that keeps replaying the same page must not spin the client.
  const stuck = new SeekForgeBridge({
    serverUrl: "http://localhost",
    token: "t",
    WebSocketImpl: class {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify(Array.from({ length: MAX_LOOP_HISTORY_ENTRIES }, () => ({ seq: 0, ts: "", event: {} }))),
        { status: 200 },
      ),
  });
  const spun = await stuck.loopHistoryTail("repo", "loop-1");
  assert.equal(spun.entries.length, MAX_LOOP_HISTORY_ROWS);
});

test("a truncated history says so instead of reading as the whole log", () => {
  const entries = [{ seq: 900, ts: "2026-08-10T00:00:00Z", event: { type: "loop.done", result: {} } }];
  const partial = formatLoopReport({ loopId: "l" }, entries, { dropped: 899, truncated: false });
  assert.match(partial, /_Showing the 1 most recent of 900 retained events\._/);

  const capped = formatLoopReport({ loopId: "l" }, entries, { dropped: 899, truncated: true });
  assert.match(capped, /_Showing the 1 most recent of 900\+ retained events\._/);

  // A complete log claims nothing about omissions.
  assert.doesNotMatch(formatLoopReport({ loopId: "l" }, entries), /most recent of/);
});
