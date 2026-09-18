const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { decodeHostMessage } = require("../media/chat-shared.js");
const { SERVER_PROMPT_TIMEOUT_MS } = require("../src/bridge.cjs");
const { ChatController, EXECUTE_PLAN_TASK, buildRunFrame } = require("../src/chat-controller.cjs");

const ROOT = path.resolve("/repo");

/** A bridge whose runs the test drives frame by frame. */
function fakeBridge() {
  const runs = [];
  return {
    runs,
    sessionsResult: [{ id: "s-old", task: "older task", status: "completed", updatedAt: "2026-09-01T10:00:00Z" }],
    async sessions() {
      return this.sessionsResult;
    },
    async sessionTranscript(_ws, id) {
      return {
        meta: { id, usage: { promptTokens: 9, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.5 } },
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      };
    },
    async files(_ws, query) {
      return [`src/${query}.ts`];
    },
    run(frame, onFrame, { signal }) {
      return new Promise((resolve, reject) => {
        const run = {
          frame,
          replies: [],
          closed: false,
          emit(message) {
            onFrame(message, (reply) => {
              if (run.closed) throw new Error("WebSocket is not open");
              run.replies.push(reply);
            });
          },
          finish() {
            run.closed = true;
            resolve();
          },
          fail(error) {
            run.closed = true;
            reject(error);
          },
        };
        signal.addEventListener(
          "abort",
          () => run.fail(Object.assign(new Error("SeekForge run cancelled"), { name: "AbortError" })),
          { once: true },
        );
        runs.push(run);
      });
    },
  };
}

function harness(overrides = {}) {
  const bridge = fakeBridge();
  const posted = [];
  const logs = [];
  const problems = [];
  const attention = [];
  const statuses = [];
  const timers = new Set();
  let now = 1_000_000;
  const contextFor = overrides.context ?? (() => ({ workspaceRoot: ROOT, activeFile: "src/app.ts" }));
  const controller = new ChatController({
    connect: overrides.connect ?? (async (root) => ({ bridge, workspaceRoot: root ?? ROOT, workspaceId: "ws1" })),
    gatherContext: contextFor,
    pinSelection: overrides.pinSelection,
    reviewDiff: overrides.reviewDiff,
    attention: (kind, text) => attention.push([kind, text]),
    onProblem: (error) => problems.push(error),
    onStatus: (status) => statuses.push(status),
    log: (line) => logs.push(line),
    activeSessions: overrides.activeSessions,
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  controller.attach((message) => {
    const decoded = decodeHostMessage(message);
    assert.equal(decoded.ok, true, `webview would drop ${JSON.stringify(message).slice(0, 200)}: ${decoded.error}`);
    posted.push(message);
  });
  const fireTimers = (predicate = () => true) => {
    for (const timer of [...timers]) {
      if (!predicate(timer)) continue;
      timers.delete(timer);
      timer.fn();
    }
  };
  return {
    bridge,
    controller,
    posted,
    logs,
    problems,
    attention,
    statuses,
    timers,
    fireTimers,
    advance: (ms) => {
      now += ms;
    },
    of: (type) => posted.filter((message) => message.type === type),
    last: (type) => posted.filter((message) => message.type === type).at(-1),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const send = (text, extra = {}) => ({
  type: "send",
  text,
  mode: "edit",
  approvalMode: "confirm",
  includeContext: true,
  ...extra,
});

test("run frames: plan is a read-only start, and a plan follow-up keeps the session mode", () => {
  assert.deepEqual(buildRunFrame({ task: "t", mode: "plan", approvalMode: "confirm", workspaceId: "w" }), {
    type: "start",
    task: "t",
    mode: "ask",
    approvalMode: "confirm",
    plan: true,
    ws: "w",
  });
  assert.deepEqual(buildRunFrame({ task: "t", mode: "edit", approvalMode: "auto", workspaceId: "w" }), {
    type: "start",
    task: "t",
    mode: "edit",
    approvalMode: "auto",
    ws: "w",
  });
  assert.deepEqual(
    buildRunFrame({ sessionId: "s", task: "t", mode: "plan", approvalMode: "confirm", workspaceId: "w" }),
    {
      type: "send",
      sessionId: "s",
      task: "t",
      approvalMode: "confirm",
      ws: "w",
    },
  );
  assert.equal(buildRunFrame({ sessionId: "s", task: "t", mode: "ask", approvalMode: "confirm" }).mode, "ask");
});

test("a message starts a session with editor context, and the next one continues it", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  assert.equal(h.of("reset").length, 1);
  const first = h.controller.handleMessage(send("fix the bug", { mode: "ask", approvalMode: "acceptEdits" }));
  await settle();
  const run = h.bridge.runs[0];
  assert.equal(run.frame.type, "start");
  assert.equal(run.frame.mode, "ask");
  assert.equal(run.frame.approvalMode, "acceptEdits");
  assert.equal(run.frame.ws, "ws1");
  assert.match(run.frame.task, /^fix the bug\n\n---\nEditor context from VS Code[\s\S]*Active file: @src\/app\.ts/);
  h.controller.flush();
  const user = h.of("upsert").find((message) => message.item.kind === "user").item;
  assert.deepEqual(user.context, ["active src/app.ts"]);
  assert.equal(h.last("status").status.running, true);
  assert.equal(h.last("status").status.workspace, "repo");

  run.emit({ type: "hello", protocolVersion: 1 });
  run.emit({ type: "event", event: { type: "session.created", sessionId: "s1" } });
  run.emit({ type: "event", event: { type: "model.delta", chunk: "Looking" } });
  run.emit({ type: "event", event: { type: "model.delta", chunk: " now" } });
  h.controller.flush();
  // Consecutive deltas reach the webview as one merged append.
  assert.deepEqual(h.of("append").at(-1), { type: "append", id: 2, text: " now" });
  run.emit({ type: "event", event: { type: "tool.started", toolName: "read_file", args: { path: "a" } } });
  run.finish();
  await first;
  h.controller.flush();
  assert.equal(h.last("status").status.running, false);
  assert.equal(h.last("status").status.sessionId, "s1");
  assert.ok(h.logs.some((line) => line.includes("⏺ read_file(a)")));

  const second = h.controller.handleMessage(send("and the tests", { includeContext: false }));
  await settle();
  const followUp = h.bridge.runs[1].frame;
  assert.deepEqual(followUp, {
    type: "send",
    sessionId: "s1",
    task: "and the tests",
    approvalMode: "confirm",
    mode: "edit",
    ws: "ws1",
  });
  h.bridge.runs[1].finish();
  await second;
  assert.ok(h.statuses.some((status) => status.running) && h.statuses.at(-1).running === false);
});

test("a message is refused while a run is active and the draft goes back to the composer", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  const first = h.controller.handleMessage(send("one"));
  await settle();
  await h.controller.handleMessage(send("two"));
  h.controller.flush();
  assert.equal(h.bridge.runs.length, 1);
  assert.deepEqual(h.last("insertText"), { type: "insertText", text: "two" });
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /still working/.test(m.item.text)));
  h.bridge.runs[0].finish();
  await first;
});

test("a message too large for one frame is refused before anything is sent", async () => {
  const h = harness({ context: () => ({ workspaceRoot: ROOT, openFiles: ["x".repeat(1_100_000)] }) });
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage(send("hello"));
  h.controller.flush();
  assert.equal(h.bridge.runs.length, 0);
  assert.deepEqual(h.last("insertText"), { type: "insertText", text: "hello" });
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /too large/.test(m.item.text)));
  assert.equal(
    h.controller.state.items.some((item) => item.kind === "user"),
    false,
  );
});

test("an unreachable server restores the draft and offers help", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const h = harness({
    connect: async () => {
      throw refused;
    },
  });
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage(send("hello"));
  h.controller.flush();
  assert.deepEqual(h.problems, [refused]);
  assert.deepEqual(h.last("insertText"), { type: "insertText", text: "hello" });
  assert.equal(h.controller.running, false);
});

const permissionRequest = {
  toolName: "run_command",
  permission: "execute",
  description: "Run a command",
  command: "pnpm test",
  rememberRule: { action: "allow", tool: "run_command", match: "pnpm test" },
};

async function startedRun(h) {
  await h.controller.handleMessage({ type: "ready" });
  const running = h.controller.handleMessage(send("go"));
  await settle();
  return { run: h.bridge.runs.at(-1), running };
}

test("a permission request is shown, answered once, and cleared", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  const card = h.last("permission").pending;
  assert.equal(card.command, "pnpm test");
  assert.equal(card.rule, "allow run_command: pnpm test");
  assert.equal(card.expiresAt, 1_000_000 + SERVER_PROMPT_TIMEOUT_MS);
  assert.deepEqual(h.attention, [["permission", "Run a command"]]);
  assert.ok(h.logs.some((line) => line.includes("Raw command: pnpm test")));

  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "always" });
  assert.deepEqual(run.replies, [{ type: "permission.response", requestId: "p1", approved: true, remember: "always" }]);
  assert.equal(h.last("permission").pending, null);
  // The same request cannot be answered twice.
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "once" });
  assert.equal(run.replies.length, 1);
  run.finish();
  await running;
});

test("a forged or stale permission answer changes nothing", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "permission.request", requestId: "p1", request: { ...permissionRequest, sessionGrantable: false } });
  assert.equal(h.last("permission").pending.allowSession, false);
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "session" });
  await h.controller.handleMessage({ type: "permission", requestId: "p2", decision: "once" });
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "hunks", selectedHunks: [0] });
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "once", sneaky: true });
  assert.deepEqual(run.replies, []);
  assert.equal(h.controller.permissions.length, 1);
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "deny", feedback: " not now " });
  assert.deepEqual(run.replies, [
    { type: "permission.response", requestId: "p1", approved: false, feedback: "not now" },
  ]);
  assert.ok(h.logs.some((line) => line === "[permission] deny — not now"));
  run.finish();
  await running;
});

test("queued permission requests are shown one at a time", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  run.emit({ type: "permission.request", requestId: "p2", request: { ...permissionRequest, command: "pnpm lint" } });
  assert.equal(h.last("permission").pending.requestId, "p1");
  await h.controller.handleMessage({ type: "permission", requestId: "p2", decision: "once" });
  assert.deepEqual(run.replies, []);
  await h.controller.handleMessage({ type: "permission", requestId: "p1", decision: "once" });
  assert.equal(h.last("permission").pending.requestId, "p2");
  assert.equal(h.last("permission").pending.command, "pnpm lint");
  run.finish();
  await running;
  // Ending the run drops the unanswered one; the server denies it on close.
  assert.equal(h.last("permission").pending, null);
  assert.equal(h.timers.size, 0);
});

test("a permission request expires when the server would have denied it", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  h.advance(30_000);
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  const expiry = [...h.timers].find((timer) => timer.ms === SERVER_PROMPT_TIMEOUT_MS);
  assert.ok(expiry, "an expiry timer matching the server timeout");
  h.fireTimers((timer) => timer === expiry);
  h.controller.flush();
  assert.equal(h.last("permission").pending, null);
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /timed out and was denied/.test(m.item.text)));
  // The server answers a late reply with unknown_request; the run carries on.
  run.emit({ type: "error", code: "unknown_request", message: "no pending permission request: p1" });
  h.controller.flush();
  assert.ok(
    h.of("upsert").some((m) => m.item.kind === "notice" && /after the server had stopped waiting/.test(m.item.text)),
  );
  run.finish();
  await running;
});

test("a server permission.expired frame removes the matching review immediately", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  run.emit({ type: "permission.expired", requestId: "p1" });
  h.controller.flush();
  assert.equal(h.last("permission").pending, null);
  assert.equal(h.controller.permissions.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /timed out and was denied/.test(m.item.text)));
  run.finish();
  await running;
});

test("the review diff opens only for the request on screen", async () => {
  const reviewed = [];
  const h = harness({ reviewDiff: async (request) => reviewed.push(request) });
  const { run, running } = await startedRun(h);
  const request = { ...permissionRequest, preview: { path: "a", diff: "--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-x\n+y" } };
  run.emit({ type: "permission.request", requestId: "p1", request });
  await h.controller.handleMessage({ type: "openReviewDiff", requestId: "p9" });
  await h.controller.handleMessage({ type: "openReviewDiff", requestId: "p1" });
  assert.deepEqual(reviewed, [request]);
  run.finish();
  await running;
});

test("questions accept an offered option, free text only when allowed, or a decline", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "question.request", id: "q1", question: "Which DB?", options: ["Postgres", "SQLite", 7] });
  assert.deepEqual(h.last("question").pending.options, ["Postgres", "SQLite"]);
  assert.equal(h.last("question").pending.freeText, false);
  await h.controller.handleMessage({ type: "question", id: "q1", answer: "MySQL" });
  assert.deepEqual(run.replies, []);
  await h.controller.handleMessage({ type: "question", id: "q1", answer: "SQLite" });
  assert.deepEqual(run.replies, [{ type: "question.answer", id: "q1", answer: "SQLite" }]);

  run.emit({ type: "question.request", id: "q2", question: "Name?", options: ["a"], freeText: true });
  await h.controller.handleMessage({ type: "question", id: "q2", answer: "my-own-name" });
  run.emit({ type: "question.request", id: "q3", question: "Continue?", options: ["yes"] });
  await h.controller.handleMessage({ type: "question", id: "q3", answer: "" });
  assert.deepEqual(run.replies.slice(1), [
    { type: "question.answer", id: "q2", answer: "my-own-name" },
    { type: "question.answer", id: "q3", answer: "" },
  ]);
  assert.equal(h.last("question").pending, null);
  run.finish();
  await running;
});

test("an answer after the socket closed is reported, not thrown", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "question.request", id: "q1", question: "?", options: ["a"] });
  run.closed = true;
  await h.controller.handleMessage({ type: "question", id: "q1", answer: "a" });
  h.controller.flush();
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /ended before the answer/.test(m.item.text)));
  run.finish();
  await running;
});

test("stop cancels the run and says so", async () => {
  const h = harness();
  const { running } = await startedRun(h);
  await h.controller.handleMessage({ type: "stop" });
  await running;
  h.controller.flush();
  assert.equal(h.controller.running, false);
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /cancelled/.test(m.item.text)));
});

test("a finished plan offers execution, which continues the session in edit mode", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  const planning = h.controller.handleMessage(send("plan the refactor", { mode: "plan", includeContext: false }));
  await settle();
  const run = h.bridge.runs[0];
  assert.equal(run.frame.plan, true);
  run.emit({ type: "event", event: { type: "session.created", sessionId: "s-plan" } });
  run.emit({ type: "event", event: { type: "session.completed", report: { summary: "1. do x" } } });
  run.finish();
  await planning;
  h.controller.flush();
  assert.equal(h.last("status").status.planReady, true);

  const executing = h.controller.handleMessage({ type: "executePlan" });
  await settle();
  assert.deepEqual(h.bridge.runs[1].frame, {
    type: "send",
    sessionId: "s-plan",
    task: EXECUTE_PLAN_TASK,
    approvalMode: "confirm",
    mode: "edit",
    ws: "ws1",
  });
  h.bridge.runs[1].finish();
  await executing;
  h.controller.flush();
  assert.equal(h.last("status").status.planReady, false);
  // Nothing to execute now.
  await h.controller.handleMessage({ type: "executePlan" });
  assert.equal(h.bridge.runs.length, 2);
});

test("a failed plan run does not offer execution", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  const planning = h.controller.handleMessage(send("plan", { mode: "plan" }));
  await settle();
  h.bridge.runs[0].emit({ type: "event", event: { type: "session.created", sessionId: "s" } });
  h.bridge.runs[0].fail(Object.assign(new Error("model error"), { code: "agent_error" }));
  await planning;
  h.controller.flush();
  assert.equal(h.last("status").status.planReady, false);
});

test("sessions can be listed and resumed with their history and cost", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage({ type: "listSessions" });
  assert.deepEqual(h.last("sessions").sessions, [
    { id: "s-old", title: "older task", updatedAt: "2026-09-01T10:00:00Z", status: "completed" },
  ]);
  await h.controller.handleMessage({ type: "resumeSession", sessionId: "s-old" });
  const reset = h.last("reset");
  assert.deepEqual(
    reset.items.map((item) => item.text),
    ["earlier question", "earlier answer"],
  );
  assert.equal(reset.status.sessionId, "s-old");
  assert.equal(reset.status.usage.costUsd, 0.5);
  const continuing = h.controller.handleMessage(send("more", { includeContext: false }));
  await settle();
  assert.equal(h.bridge.runs[0].frame.sessionId, "s-old");
  h.bridge.runs[0].finish();
  await continuing;

  await h.controller.handleMessage({ type: "newSession" });
  assert.equal(h.last("reset").items.length, 0);
  assert.equal(h.last("reset").status.sessionId, null);
});

test("one session is never driven from two chats at once", async () => {
  const activeSessions = new Set();
  const a = harness({ activeSessions });
  const b = harness({ activeSessions });
  await a.controller.handleMessage({ type: "ready" });
  await b.controller.handleMessage({ type: "ready" });
  await b.controller.handleMessage({ type: "resumeSession", sessionId: "shared" });
  await a.controller.handleMessage({ type: "resumeSession", sessionId: "shared" });
  const running = a.controller.handleMessage(send("from a"));
  await settle();
  assert.ok(activeSessions.has("shared"));
  await b.controller.handleMessage(send("from b"));
  assert.equal(b.bridge.runs.length, 0);
  assert.deepEqual(b.last("insertText"), { type: "insertText", text: "from b" });
  a.bridge.runs[0].finish();
  await running;
  assert.equal(activeSessions.has("shared"), false);
  // Switching or clearing is refused mid-run, too.
  const again = a.controller.handleMessage(send("again"));
  await settle();
  await a.controller.handleMessage({ type: "newSession" });
  await a.controller.handleMessage({ type: "resumeSession", sessionId: "other" });
  assert.equal(a.controller.state.status.sessionId, "shared");
  a.bridge.runs[1].finish();
  await again;
});

test("an attached selection is sent only while its reference stays in the message", async () => {
  const selection = {
    path: path.join(ROOT, "src/a.ts"),
    startLine: 2,
    endLine: 4,
    text: "const a = 1;",
    truncated: false,
    languageId: "typescript",
  };
  const h = harness({ pinSelection: () => ({ reference: "@src/a.ts#L2-4", selection }) });
  // The chat was opened by the same command: the insert waits for the view.
  await h.controller.handleMessage({ type: "addSelection" });
  assert.equal(h.of("insertText").length, 0);
  await h.controller.handleMessage({ type: "ready" });
  assert.deepEqual(h.last("insertText"), { type: "insertText", text: "@src/a.ts#L2-4 " });

  const withRef = h.controller.handleMessage(send("explain @src/a.ts#L2-4", { includeContext: false }));
  await settle();
  assert.match(h.bridge.runs[0].frame.task, /Attached @src\/a\.ts lines 2-4:\n```typescript\nconst a = 1;\n```/);
  h.bridge.runs[0].finish();
  await withRef;

  await h.controller.handleMessage({ type: "addSelection" });
  const withoutRef = h.controller.handleMessage(send("never mind", { includeContext: false }));
  await settle();
  assert.equal(h.bridge.runs[1].frame.task, "never mind");
  h.bridge.runs[1].finish();
  await withoutRef;
});

test("add selection without a usable selection explains why", async () => {
  const h = harness({ pinSelection: () => undefined });
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage({ type: "addSelection" });
  h.controller.flush();
  assert.ok(h.of("upsert").some((m) => m.item.kind === "notice" && /Select some text/.test(m.item.text)));
});

test("file search results go back for the typed query", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage({ type: "searchFiles", query: "app" });
  assert.deepEqual(h.last("files"), { type: "files", query: "app", files: ["src/app.ts"] });
});

test("malformed webview messages are dropped and logged", async () => {
  const h = harness();
  await h.controller.handleMessage({
    type: "send",
    text: "x",
    mode: "root",
    approvalMode: "confirm",
    includeContext: true,
  });
  await h.controller.handleMessage({ type: "runCommand", command: "rm -rf /" });
  await h.controller.handleMessage("ready");
  assert.equal(h.bridge.runs.length, 0);
  assert.equal(h.logs.filter((line) => line.startsWith("[chat] ignored")).length, 3);
});

test("frames from a run that already ended never reach the next run", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  await h.controller.handleMessage({ type: "stop" });
  await running;
  // The server was still winding down the cancelled run.
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  run.emit({ type: "event", event: { type: "model.delta", chunk: "stale" } });
  h.controller.flush();
  assert.equal(h.controller.permissions.length, 0);
  assert.equal(h.of("permission").length, 0);
  assert.equal(h.timers.size, 0);

  const next = h.controller.handleMessage(send("again"));
  await settle();
  run.emit({ type: "event", event: { type: "model.delta", chunk: "stale again" } });
  h.bridge.runs[1].emit({ type: "event", event: { type: "model.delta", chunk: "fresh" } });
  h.bridge.runs[1].finish();
  await next;
  const texts = h.controller.state.items.filter((item) => item.kind === "assistant").map((item) => item.text);
  assert.deepEqual(texts, ["fresh"]);
});

test("a double send starts one run, even before the first has connected", async () => {
  const h = harness();
  await h.controller.handleMessage({ type: "ready" });
  const first = h.controller.handleMessage(send("once"));
  const second = h.controller.handleMessage(send("twice"));
  await settle();
  assert.equal(h.bridge.runs.length, 1);
  h.controller.flush();
  assert.deepEqual(h.last("insertText"), { type: "insertText", text: "twice" });
  h.bridge.runs[0].finish();
  await Promise.all([first, second]);
});

test("two chats racing for one session: only the first reservation wins", async () => {
  const activeSessions = new Set();
  const a = harness({ activeSessions });
  const b = harness({ activeSessions });
  for (const h of [a, b]) {
    await h.controller.handleMessage({ type: "ready" });
    await h.controller.handleMessage({ type: "resumeSession", sessionId: "shared" });
  }
  // No settle between the two: both checks happen before either connects.
  const fromA = a.controller.handleMessage(send("from a"));
  const fromB = b.controller.handleMessage(send("from b"));
  await settle();
  assert.equal(a.bridge.runs.length + b.bridge.runs.length, 1);
  assert.equal(b.bridge.runs.length, 0);
  assert.deepEqual(b.last("insertText"), { type: "insertText", text: "from b" });
  a.bridge.runs[0].finish();
  await Promise.all([fromA, fromB]);
  assert.equal(activeSessions.size, 0);
});

test("a refused message releases the session it reserved", async () => {
  const activeSessions = new Set();
  const h = harness({ activeSessions, context: () => ({ workspaceRoot: ROOT, openFiles: ["x".repeat(1_100_000)] }) });
  await h.controller.handleMessage({ type: "ready" });
  await h.controller.handleMessage({ type: "resumeSession", sessionId: "s-big" });
  await h.controller.handleMessage(send("too big"));
  assert.equal(h.bridge.runs.length, 0);
  assert.equal(activeSessions.has("s-big"), false);
  assert.equal(h.controller.busy, false);
});

test("dispose stops the run and clears timers", async () => {
  const h = harness();
  const { run, running } = await startedRun(h);
  run.emit({ type: "permission.request", requestId: "p1", request: permissionRequest });
  h.controller.dispose();
  await running;
  assert.equal(h.timers.size, 0);
  const before = h.posted.length;
  run.emit({ type: "event", event: { type: "model.delta", chunk: "late" } });
  h.controller.flush();
  assert.equal(h.posted.length, before);
});
