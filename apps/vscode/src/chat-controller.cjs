const path = require("node:path");
const { LIMITS, decodeWebviewMessage } = require("../media/chat-shared.js");
const {
  SERVER_PROMPT_TIMEOUT_MS,
  clipLine,
  connectionProblem,
  formatAgentEvent,
  permissionResponse,
  permissionSummary,
  permissionView,
} = require("./bridge.cjs");
const { ChatState, usageView } = require("./chat-state.cjs");
const { MAX_PINNED_SELECTIONS, contextLabels, taskWithContext } = require("./editor-context.cjs");

/** The server refuses a frame above this many serialized bytes (protocol-limits). */
const MAX_FRAME_BYTES = 1_000_000;
/** The canned follow-up that turns a finished plan into an edit run (same text as Desktop). */
const EXECUTE_PLAN_TASK =
  "Execute the plan you produced above, step by step. Make the changes and run the verification.";
const APPEND_FLUSH_MS = 16;
const MAX_FILE_RESULTS = 50;
const MAX_PENDING_INSERTS = 10;

const DEFAULT_OPTIONS = Object.freeze({ mode: "edit", approvalMode: "confirm", includeContext: true });

/**
 * The start/send frame for one message. "plan" is a read-only ask run with the
 * plan flag, and a start-only concept: a follow-up keeps the session's own mode
 * unless the user picked ask or edit explicitly.
 */
function buildRunFrame({ sessionId, task, mode, approvalMode, workspaceId }) {
  if (!sessionId) {
    return mode === "plan"
      ? { type: "start", task, mode: "ask", approvalMode, plan: true, ws: workspaceId }
      : { type: "start", task, mode, approvalMode, ws: workspaceId };
  }
  return {
    type: "send",
    sessionId,
    task,
    approvalMode,
    ...(mode === "plan" ? {} : { mode }),
    ws: workspaceId,
  };
}

/**
 * One conversation: its transcript state, its active run, and the prompts that
 * run is waiting on. Editor effects are injected, so the whole flow runs under
 * test without VS Code.
 */
class ChatController {
  constructor({
    connect,
    gatherContext = () => undefined,
    pinSelection = () => undefined,
    reviewDiff = async () => {},
    openWorkspaceFile = async () => {},
    openInEditor = async () => {},
    attention = () => {},
    onProblem = () => {},
    onStatus = () => {},
    log = () => {},
    activeSessions = new Set(),
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    options = DEFAULT_OPTIONS,
  }) {
    this.deps = {
      connect,
      gatherContext,
      pinSelection,
      reviewDiff,
      openWorkspaceFile,
      openInEditor,
      attention,
      onProblem,
      onStatus,
      log,
    };
    this.activeSessions = activeSessions;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = new ChatState();
    this.views = new Set();
    this.outbox = [];
    this.flushTimer = undefined;
    this.workspace = undefined;
    this.pinned = new Map();
    this.permissions = [];
    this.questions = [];
    this.abort = undefined;
    this.planRun = false;
    this.disposed = false;
    this.viewReady = false;
    this.pendingInserts = [];
    this.starting = false;
    this.generation = 0;
  }

  get running() {
    return this.state.status.running;
  }

  /** Adds a webview; it is sent the whole conversation once it reports ready. */
  attach(post) {
    this.views.add(post);
    return () => {
      this.views.delete(post);
      if (this.views.size === 0) this.viewReady = false;
    };
  }

  /**
   * Text for the composer. A view that has not loaded yet (the sidebar is
   * opened by the same command that inserts) receives it once it is ready.
   */
  insertText(text) {
    if (this.viewReady && this.views.size > 0) this.postNow({ type: "insertText", text });
    else this.pendingInserts = [...this.pendingInserts, text].slice(-MAX_PENDING_INSERTS);
  }

  postNow(message) {
    for (const post of this.views) {
      try {
        post(message);
      } catch {
        // A disposed webview drops out on its own dispose event.
      }
    }
  }

  resetViews() {
    this.outbox = [];
    const snapshot = this.state.snapshot();
    this.postNow({ type: "reset", ...snapshot, options: { ...this.options } });
  }

  /** Queues ops; consecutive text appends to one item are merged before posting. */
  emit(ops) {
    if (ops.some((op) => op.type === "reset")) {
      this.resetViews();
      return;
    }
    for (const op of ops) {
      if (op.type === "status") this.deps.onStatus(op.status);
      const last = this.outbox[this.outbox.length - 1];
      if (op.type === "append" && last?.type === "append" && last.id === op.id) last.text += op.text;
      else this.outbox.push({ ...op });
    }
    if (this.flushTimer === undefined && this.outbox.length > 0) {
      this.flushTimer = this.setTimer(() => this.flush(), APPEND_FLUSH_MS);
    }
  }

  flush() {
    if (this.flushTimer !== undefined) this.clearTimer(this.flushTimer);
    this.flushTimer = undefined;
    const pending = this.outbox;
    this.outbox = [];
    for (const message of pending) this.postNow(message);
  }

  notice(level, text) {
    this.emit(this.state.notice(level, text));
  }

  /** Entry point for every webview message; malformed ones are dropped. */
  async handleMessage(raw) {
    const decoded = decodeWebviewMessage(raw);
    if (!decoded.ok) {
      this.deps.log(`[chat] ignored a malformed webview message: ${decoded.error}`);
      return;
    }
    const message = decoded.message;
    try {
      await this.dispatch(message);
    } catch (error) {
      this.reportError(error);
    }
  }

  async dispatch(message) {
    switch (message.type) {
      case "ready":
        this.viewReady = true;
        this.resetViews();
        for (const text of this.pendingInserts.splice(0)) this.postNow({ type: "insertText", text });
        return;
      case "setOptions":
        this.options = {
          mode: message.mode,
          approvalMode: message.approvalMode,
          includeContext: message.includeContext,
        };
        return;
      case "send":
        this.options = {
          mode: message.mode,
          approvalMode: message.approvalMode,
          includeContext: message.includeContext,
        };
        await this.send(message.text, this.options);
        return;
      case "stop":
        this.stop();
        return;
      case "newSession":
        this.newSession();
        return;
      case "listSessions":
        await this.listSessions();
        return;
      case "resumeSession":
        await this.resume(message.sessionId);
        return;
      case "permission":
        this.answerPermission(message);
        return;
      case "openReviewDiff": {
        const head = this.permissions[0];
        if (head?.requestId === message.requestId) await this.deps.reviewDiff(head.request);
        return;
      }
      case "question":
        this.answerQuestion(message.id, message.answer);
        return;
      case "searchFiles":
        await this.searchFiles(message.query);
        return;
      case "addSelection":
        this.addSelection();
        return;
      case "executePlan":
        if (this.state.status.planReady && !this.busy) {
          await this.send(EXECUTE_PLAN_TASK, { ...this.options, mode: "edit", includeContext: false });
        }
        return;
      case "openFile":
        if (this.workspace) await this.deps.openWorkspaceFile(this.workspace.root, message.path);
        return;
      case "openInEditor":
        await this.deps.openInEditor();
        return;
      default:
        return;
    }
  }

  reportError(error) {
    const text = error instanceof Error ? error.message : String(error);
    this.notice("error", text);
    if (connectionProblem(error) !== "other") this.deps.onProblem(error);
  }

  /** The workspace this conversation belongs to, pinned at its first message. */
  async connection() {
    const connected = await this.deps.connect(this.workspace?.root);
    if (!this.workspace) {
      this.workspace = { root: connected.workspaceRoot, id: connected.workspaceId };
      this.emit(this.state.setStatus({ workspace: path.basename(connected.workspaceRoot) }));
    }
    return connected;
  }

  newSession() {
    if (this.busy) {
      this.notice("warn", "Stop the current run before starting a new conversation.");
      return;
    }
    this.state.clear();
    this.workspace = undefined;
    this.pinned.clear();
    this.planRun = false;
    this.resetViews();
  }

  async listSessions() {
    const { bridge, workspaceId } = await this.connection();
    const sessions = await bridge.sessions(workspaceId);
    this.postNow({
      type: "sessions",
      sessions: sessions.slice(0, LIMITS.listEntries).map((session) => ({
        id: String(session.id).slice(0, LIMITS.idChars),
        title: clipLine(session.title || session.task || session.id, 300),
        updatedAt: String(session.updatedAt ?? session.createdAt ?? "").slice(0, 100),
        status: String(session.status ?? "").slice(0, 40),
      })),
    });
  }

  async resume(sessionId) {
    if (this.busy) {
      this.notice("warn", "Stop the current run before switching conversations.");
      return;
    }
    const { bridge, workspaceId, workspaceRoot } = await this.deps.connect(this.workspace?.root);
    const { meta, messages } = await bridge.sessionTranscript(workspaceId, sessionId);
    this.state.clear();
    this.pinned.clear();
    this.planRun = false;
    this.workspace = { root: workspaceRoot, id: workspaceId };
    this.state.loadTranscript(messages);
    this.state.setStatus({
      sessionId,
      workspace: path.basename(workspaceRoot),
      usage: usageView(meta?.usage),
    });
    this.resetViews();
  }

  async searchFiles(query) {
    if (!this.workspace && !query) return;
    const { bridge, workspaceId } = await this.connection();
    const files = await bridge.files(workspaceId, query);
    this.postNow({ type: "files", query, files: files.slice(0, MAX_FILE_RESULTS) });
  }

  /** Pins the current selection for the next message and inserts its reference. */
  addSelection(pinned = this.deps.pinSelection(this.workspace?.root)) {
    if (!pinned) {
      this.notice("warn", "Select some text in a workspace file first.");
      return;
    }
    if (!this.pinned.has(pinned.reference) && this.pinned.size >= MAX_PINNED_SELECTIONS) {
      this.pinned.delete(this.pinned.keys().next().value);
    }
    this.pinned.set(pinned.reference, pinned.selection);
    this.insertText(`${pinned.reference} `);
  }

  /** Starting (awaiting the connection) counts as busy, so a double send cannot start two runs. */
  get busy() {
    return this.running || this.starting;
  }

  async send(text, options) {
    if (this.busy) {
      this.notice("warn", "SeekForge is still working on the previous message.");
      this.insertText(text);
      return;
    }
    const sessionId = this.state.status.sessionId;
    if (sessionId && this.activeSessions.has(sessionId)) {
      this.notice("warn", "This session is running in another SeekForge view.");
      this.insertText(text);
      return;
    }
    // Reserve before the first await: another chat checking the same session
    // in the meantime must see it taken.
    this.starting = true;
    if (sessionId) this.activeSessions.add(sessionId);
    let prepared;
    try {
      prepared = await this.prepare(text, options, sessionId);
    } finally {
      this.starting = false;
      if (!prepared && sessionId) this.activeSessions.delete(sessionId);
    }
    if (prepared) await this.execute(text, options, prepared);
  }

  /** Everything before the run: connection, context, and the frame-size check. Undefined means refused. */
  async prepare(text, options, sessionId) {
    let connected;
    try {
      connected = await this.connection();
    } catch (error) {
      this.insertText(text);
      throw error;
    }
    if (this.disposed) return undefined;
    const { bridge, workspaceId, workspaceRoot } = connected;
    const context = options.includeContext ? this.deps.gatherContext(workspaceRoot) : undefined;
    // A pinned selection travels only if its reference is still in the message.
    const pinned = [...this.pinned].filter(([reference]) => text.includes(reference)).map(([, selection]) => selection);
    const task = taskWithContext(text, context ?? { workspaceRoot }, pinned);
    const frame = buildRunFrame({
      sessionId,
      task,
      mode: options.mode,
      approvalMode: options.approvalMode,
      workspaceId,
    });
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
      this.notice("error", "This message is too large to send. Shorten it or attach less context.");
      this.insertText(text);
      return undefined;
    }
    return { bridge, frame, labels: contextLabels(context, pinned) };
  }

  async execute(text, options, { bridge, frame, labels }) {
    this.pinned.clear();
    // A follow-up typed in plan mode keeps refining the same read-only plan.
    this.planRun = options.mode === "plan";
    this.emit(this.state.addUser(text, labels));
    this.emit(this.state.setStatus({ running: true, planReady: false, activity: null }));
    this.deps.log(`\n> ${clipLine(text, 400)}`);
    // Frames are bound to the run that received them: anything a closing
    // socket still delivers after this run ended is dropped.
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    let completed = false;
    try {
      await bridge.run(
        frame,
        (message, reply) => {
          if (generation !== this.generation) return;
          if (message?.type === "event" && message.event?.type === "session.completed") completed = true;
          this.onFrame(message, reply);
        },
        { signal: abort.signal },
      );
    } catch (error) {
      if (error?.name === "AbortError") this.notice("info", clipLine(error.message, 300));
      else this.reportError(error);
    } finally {
      this.generation += 1;
      this.abort = undefined;
      const id = this.state.status.sessionId;
      if (id) this.activeSessions.delete(id);
      if (frame.sessionId && frame.sessionId !== id) this.activeSessions.delete(frame.sessionId);
      this.dropPrompts("The run ended before this was answered.");
      this.emit(
        this.state.setStatus({
          running: false,
          activity: null,
          planReady: this.planRun && completed && Boolean(id),
        }),
      );
      this.flush();
    }
  }

  stop() {
    this.abort?.abort();
  }

  onFrame(message, reply) {
    if (this.disposed || !message || typeof message.type !== "string") return;
    switch (message.type) {
      case "event": {
        const event = message.event;
        if (event?.type === "session.created" && typeof event.sessionId === "string") {
          this.activeSessions.add(event.sessionId);
        }
        this.emit(this.state.applyEvent(event));
        const line = formatAgentEvent(event);
        if (line !== null) this.deps.log(line);
        return;
      }
      case "permission.request":
        if (typeof message.requestId !== "string" || !message.request || typeof message.request !== "object") return;
        this.permissions.push({
          requestId: message.requestId,
          request: message.request,
          reply,
          receivedAt: this.now(),
        });
        this.deps.log(`[permission] ${permissionSummary(message.request).replaceAll("\n", " ")}`);
        if (this.permissions.length === 1) this.showPermission();
        return;
      case "permission.expired": {
        if (typeof message.requestId !== "string") return;
        const index = this.permissions.findIndex((entry) => entry.requestId === message.requestId);
        if (index < 0) return;
        const [expired] = this.permissions.splice(index, 1);
        this.clearTimer(expired.timer);
        this.notice(
          "warn",
          `Permission request timed out and was denied: ${clipLine(expired.request.description, 200)}`,
        );
        if (index === 0) this.showPermission();
        return;
      }
      case "question.request":
        if (typeof message.id !== "string" || typeof message.question !== "string") return;
        this.questions.push({
          id: message.id,
          question: message.question,
          options: Array.isArray(message.options) ? message.options.filter((option) => typeof option === "string") : [],
          freeText: message.freeText === true,
          reply,
          receivedAt: this.now(),
        });
        if (this.questions.length === 1) this.showQuestion();
        return;
      case "error":
        if (message.code === "unknown_request") {
          this.notice("warn", "That answer arrived after the server had stopped waiting for it.");
        }
        return;
      default:
        return;
    }
  }

  armExpiry(entry, onExpire) {
    const delay = Math.max(0, entry.receivedAt + SERVER_PROMPT_TIMEOUT_MS - this.now());
    entry.timer = this.setTimer(onExpire, delay);
  }

  showPermission() {
    const head = this.permissions[0];
    if (!head) {
      this.state.permission = null;
      this.flush();
      this.postNow({ type: "permission", pending: null });
      return;
    }
    const view = permissionView(head.requestId, head.request, head.receivedAt);
    this.state.permission = view;
    this.armExpiry(head, () => {
      if (this.permissions[0] !== head) return;
      this.permissions.shift();
      this.notice("warn", `Permission request timed out and was denied: ${clipLine(head.request.description, 200)}`);
      this.showPermission();
    });
    this.flush();
    this.postNow({ type: "permission", pending: view });
    this.deps.attention("permission", view.description);
  }

  showQuestion() {
    const head = this.questions[0];
    if (!head) {
      this.state.question = null;
      this.flush();
      this.postNow({ type: "question", pending: null });
      return;
    }
    const view = {
      id: head.id,
      question: head.question.slice(0, LIMITS.shortText),
      options: head.options.slice(0, 50).map((option) => option.slice(0, LIMITS.shortText)),
      freeText: head.freeText,
      expiresAt: head.receivedAt + SERVER_PROMPT_TIMEOUT_MS,
    };
    this.state.question = view;
    this.armExpiry(head, () => {
      if (this.questions[0] !== head) return;
      this.questions.shift();
      this.notice("warn", "The question timed out and was treated as declined.");
      this.showQuestion();
    });
    this.flush();
    this.postNow({ type: "question", pending: view });
    this.deps.attention("question", view.question);
  }

  answerPermission(message) {
    const head = this.permissions[0];
    // Only the request on screen can be answered; anything else is stale.
    if (!head || head.requestId !== message.requestId) return;
    let frame;
    try {
      frame = permissionResponse(head.requestId, head.request, message.decision, {
        selectedHunks: message.selectedHunks,
        feedback: message.feedback,
      });
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
      return;
    }
    this.permissions.shift();
    this.clearTimer(head.timer);
    try {
      head.reply(frame);
      this.deps.log(`[permission] ${message.decision}${frame.feedback ? ` — ${clipLine(frame.feedback, 200)}` : ""}`);
    } catch {
      this.notice("warn", "The run ended before the answer could be sent.");
    }
    this.showPermission();
  }

  answerQuestion(id, answer) {
    const head = this.questions[0];
    if (!head || head.id !== id) return;
    // Free text is only accepted where the tool asked for it; otherwise the
    // answer must be one of the offered options (or empty, which declines).
    if (answer !== "" && !head.freeText && !head.options.includes(answer)) {
      this.notice("error", "Pick one of the offered answers.");
      return;
    }
    this.questions.shift();
    this.clearTimer(head.timer);
    try {
      head.reply({ type: "question.answer", id, answer });
    } catch {
      this.notice("warn", "The run ended before the answer could be sent.");
    }
    this.showQuestion();
  }

  /** Prompts die with their socket: the server treats a closed socket as a denial. */
  dropPrompts(reason) {
    const hadPrompts = this.permissions.length > 0 || this.questions.length > 0;
    for (const entry of [...this.permissions, ...this.questions]) this.clearTimer(entry.timer);
    this.permissions = [];
    this.questions = [];
    if (!hadPrompts) return;
    this.notice("warn", reason);
    this.showPermission();
    this.showQuestion();
  }

  dispose() {
    this.disposed = true;
    this.stop();
    for (const entry of [...this.permissions, ...this.questions]) this.clearTimer(entry.timer);
    this.permissions = [];
    this.questions = [];
    if (this.flushTimer !== undefined) this.clearTimer(this.flushTimer);
    this.flushTimer = undefined;
    this.views.clear();
  }
}

module.exports = { ChatController, DEFAULT_OPTIONS, EXECUTE_PLAN_TASK, MAX_FRAME_BYTES, buildRunFrame };
