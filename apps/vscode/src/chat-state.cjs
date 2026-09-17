const { clipLine, clipToLength, formatTokens, toolArgsSummary, toolResultSummary } = require("./bridge.cjs");

/** Items kept for one conversation view; older ones are dropped with a note. */
const MAX_ITEMS = 1_000;
/** Longest assistant/thinking text kept per item. */
const MAX_TEXT = 400_000;
/** Tool detail, summary and live-output tails. */
const MAX_SHORT = 4_000;
const MAX_OUTPUT_LINES = 20;
const PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);
const SUBAGENT_STATUSES = new Set(["running", "done", "failed", "cancelled"]);

const clip = clipToLength;
/** A session id as the server mints it; anything else is not shown. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Only the four numbers the footer shows, and only when they are real numbers. */
function usageView(usage) {
  if (!usage || typeof usage !== "object") return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    costUsd: Number.isFinite(usage.costUsd) ? usage.costUsd : 0,
    promptTokens: count(usage.promptTokens),
    completionTokens: count(usage.completionTokens),
    cacheHitTokens: count(usage.cacheHitTokens),
  };
}

function planSteps(value) {
  const items = Array.isArray(value?.items) ? value.items : null;
  if (!items) return null;
  const steps = items
    .filter((item) => typeof item?.step === "string" && PLAN_STATUSES.has(item.status))
    .slice(0, 100)
    .map((item) => ({ step: clip(item.step, 1_000), status: item.status }));
  return steps.length > 0 ? steps : null;
}

function argsDetail(args) {
  try {
    return clip(JSON.stringify(args, null, 2) ?? "", MAX_SHORT);
  } catch {
    return "";
  }
}

function parseArguments(json) {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * The host-side model of one conversation. Every mutator returns the ops the
 * webview needs to catch up (`upsert`, `append`, `status`), so a view that was
 * hidden can instead be sent `snapshot()` whole.
 */
class ChatState {
  constructor() {
    this.clear();
  }

  clear() {
    this.items = [];
    this.nextId = 1;
    this.status = {
      running: false,
      sessionId: null,
      usage: null,
      contextPercent: null,
      planReady: false,
      workspace: null,
      activity: null,
    };
    this.permission = null;
    this.question = null;
    this.trimmed = 0;
    // The assistant item this model turn streamed into; its final
    // `model.message` replaces that text instead of adding a copy.
    this.turnText = undefined;
  }

  snapshot() {
    return {
      items: this.items.map((item) => ({ ...item })),
      status: { ...this.status },
      permission: this.permission,
      question: this.question,
    };
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    return [{ type: "status", status: { ...this.status } }];
  }

  add(item) {
    const full = { ...item, id: this.nextId++ };
    this.items.push(full);
    const ops = [{ type: "upsert", item: { ...full } }];
    if (this.items.length > MAX_ITEMS) {
      const dropped = this.items.length - MAX_ITEMS;
      this.items.splice(0, dropped);
      this.trimmed += dropped;
      // The webview cannot tell a trimmed transcript from a short one; a reset says so.
      ops.push({ type: "reset" });
    }
    return { item: full, ops };
  }

  update(item, patch) {
    Object.assign(item, patch);
    return [{ type: "upsert", item: { ...item } }];
  }

  last(predicate) {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (predicate(this.items[index])) return this.items[index];
    }
    return undefined;
  }

  /** Streams stop at the next structural event: a tool call ends the text before it. */
  settleStreams() {
    const ops = [];
    for (const item of this.items) {
      if ((item.kind === "assistant" || item.kind === "thinking") && item.streaming) {
        ops.push(...this.update(item, { streaming: false }));
      }
    }
    return ops;
  }

  addUser(text, context = []) {
    this.turnText = undefined;
    const ops = this.settleStreams();
    const labels = context.slice(0, 50).map((label) => clip(label, 300));
    ops.push(...this.add({ kind: "user", text: clip(text, MAX_TEXT), context: labels }).ops);
    return ops;
  }

  notice(level, text) {
    return this.add({ kind: "notice", level, text: clip(text, MAX_SHORT) }).ops;
  }

  appendStream(kind, chunk) {
    if (typeof chunk !== "string" || chunk === "") return [];
    const ops = [];
    const tail = this.items[this.items.length - 1];
    if (tail?.kind === kind && tail.streaming) {
      const room = MAX_TEXT - tail.text.length;
      if (room <= 0) return [];
      const piece = chunk.slice(0, room);
      tail.text += piece;
      return [{ type: "append", id: tail.id, text: piece }];
    }
    // Text after reasoning ends the reasoning block, and vice versa.
    ops.push(...this.settleStreams());
    const added = this.add({ kind, text: clip(chunk, MAX_TEXT), streaming: true });
    if (kind === "assistant") this.turnText = added.item;
    ops.push(...added.ops);
    return ops;
  }

  /**
   * One `event` frame's AgentEvent (plus the server's delta events). Unknown
   * event types are ignored: this view renders what it understands and the
   * transcript on disk keeps the rest.
   */
  applyEvent(event) {
    if (!event || typeof event.type !== "string") return [];
    switch (event.type) {
      case "session.created":
        return typeof event.sessionId === "string" && SESSION_ID_RE.test(event.sessionId)
          ? this.setStatus({ sessionId: event.sessionId })
          : [];
      case "model.delta":
        return this.appendStream("assistant", event.chunk);
      case "reasoning.delta":
        return this.appendStream("thinking", event.chunk);
      case "model.message": {
        const content = typeof event.content === "string" ? event.content : "";
        const streamed = this.turnText;
        this.turnText = undefined;
        if (streamed && this.items.includes(streamed)) {
          const final = this.update(streamed, { text: clip(content || streamed.text, MAX_TEXT), streaming: false });
          return [...final, ...this.settleStreams()];
        }
        const ops = this.settleStreams();
        if (content.trim()) {
          ops.push(...this.add({ kind: "assistant", text: clip(content, MAX_TEXT), streaming: false }).ops);
        }
        return ops;
      }
      case "step.started":
        return this.setStatus({ activity: clip(event.title, 300) });
      case "tool.started": {
        this.turnText = undefined;
        const ops = this.settleStreams();
        const name = clip(event.toolName, 200);
        if (event.toolName === "update_plan") return ops;
        const summary = toolArgsSummary(event.args);
        ops.push(
          ...this.add({
            kind: "tool",
            name,
            title: summary ? `${name} ${summary}` : name,
            status: "running",
            summary: "",
            detail: argsDetail(event.args),
            output: "",
          }).ops,
        );
        return ops;
      }
      case "tool.completed": {
        if (event.toolName === "update_plan") {
          const steps = event.result?.ok === false ? null : planSteps(event.result?.data);
          if (!steps) return [];
          const plan = this.last((item) => item.kind === "plan");
          return plan ? this.update(plan, { steps }) : this.add({ kind: "plan", steps }).ops;
        }
        const tool = this.last(
          (item) => item.kind === "tool" && item.status === "running" && item.name === event.toolName,
        );
        if (!tool) return [];
        return this.update(tool, {
          status: event.result?.ok === false ? "error" : "ok",
          summary: clip(toolResultSummary(event.result) || "ok", MAX_SHORT),
        });
      }
      case "command.output": {
        const tool = this.last((item) => item.kind === "tool" && item.status === "running");
        if (!tool || typeof event.chunk !== "string") return [];
        const lines = `${tool.output}${event.chunk}`.split("\n");
        return this.update(tool, { output: clip(lines.slice(-MAX_OUTPUT_LINES).join("\n"), MAX_SHORT) });
      }
      case "file.changed": {
        if (typeof event.path !== "string") return [];
        const tail = this.items[this.items.length - 1];
        if (tail?.kind === "file" && tail.path === event.path) return [];
        return this.add({ kind: "file", path: clip(event.path, 4_096) }).ops;
      }
      case "notice":
        return this.notice(event.level === "warn" ? "warn" : "info", clipLine(event.message, MAX_SHORT));
      case "context.compacted":
        return this.notice(
          "info",
          `Context compacted: ${event.droppedTurns} turn(s) summarised in ${formatTokens(event.summaryTokens)} tokens.`,
        );
      case "context.microcompacted":
        return this.notice("info", `Context trimmed: ${event.clearedResults} old tool result(s) cleared.`);
      case "context.usage":
        return Number.isFinite(event.percent) ? this.setStatus({ contextPercent: event.percent }) : [];
      case "session.continuing":
        return this.notice("info", `Continuing (slice ${event.continuation + 1} of ${event.maxContinuations + 1})…`);
      case "provider.retry":
        return this.setStatus({
          activity: `Retrying the model (${event.attempt}/${event.maxAttempts}): ${clipLine(event.reason, 120)}`,
        });
      case "usage.updated": {
        // The session window, never the run window: a resumed session restarts
        // the run count at zero, and the footer shows what the session cost.
        const usage = usageView(event.sessionUsage ?? event.usage);
        return usage ? this.setStatus({ usage }) : [];
      }
      case "subagent.started":
      case "subagent.step":
      case "subagent.completed":
      case "subagent.failed":
      case "subagent.cancelled":
        return this.applySubagent(event);
      case "session.completed": {
        const report = event.report ?? {};
        const ops = this.settleStreams();
        const usage = usageView(report.sessionUsage ?? report.usage);
        ops.push(
          ...this.add({
            kind: "report",
            summary: clip(report.summary, MAX_TEXT),
            changedFiles: (Array.isArray(report.changedFiles) ? report.changedFiles : [])
              .filter((file) => typeof file === "string")
              .slice(0, 500)
              .map((file) => clip(file, 4_096)),
            verification: clip(report.verification, MAX_SHORT),
            usage: usageView(report.usage),
          }).ops,
        );
        if (usage) ops.push(...this.setStatus({ usage }));
        return ops;
      }
      case "session.failed": {
        const ops = this.settleStreams();
        const message = event.error?.message ?? event.error?.code ?? "The run failed.";
        ops.push(...this.add({ kind: "failed", message: clip(message, MAX_SHORT) }).ops);
        return ops;
      }
      default:
        return [];
    }
  }

  /**
   * Dispatch ids restart per run, so a card is matched only while it is still
   * running: a finished card with a reused id belongs to an earlier dispatch.
   */
  applySubagent(event) {
    if (typeof event.dispatchId !== "string" || !SUBAGENT_STATUSES.has(event.status)) return [];
    const card = this.last(
      (item) => item.kind === "subagent" && item.dispatchId === event.dispatchId && item.status === "running",
    );
    const summary =
      event.type === "subagent.step"
        ? `→ ${clip(event.toolName, 200)}`
        : event.type === "subagent.completed"
          ? clipLine(event.resultSummary, MAX_SHORT)
          : event.type === "subagent.failed"
            ? clipLine(event.error?.message ?? "failed", MAX_SHORT)
            : event.type === "subagent.cancelled"
              ? clipLine(event.reason ?? "cancelled", MAX_SHORT)
              : "";
    const detail = clip(summary, MAX_SHORT);
    if (!card) {
      if (event.type !== "subagent.started" && event.type !== "subagent.step") return [];
      return this.add({
        kind: "subagent",
        dispatchId: event.dispatchId,
        agentId: clip(event.agentId, 200),
        task: clip(clipLine(event.task, MAX_SHORT), MAX_SHORT),
        status: event.status,
        detail,
      }).ops;
    }
    return this.update(card, { status: event.status, ...(detail ? { detail } : {}) });
  }

  /**
   * A stored session's messages as history. Tool calls are paired with their
   * results within each assistant turn — ids are only unique per turn.
   */
  loadTranscript(messages) {
    const ops = [];
    let pending = new Map();
    for (const message of Array.isArray(messages) ? messages : []) {
      const role = message?.role;
      const content = typeof message?.content === "string" ? message.content : "";
      if (role === "user") {
        pending = new Map();
        ops.push(...this.add({ kind: "user", text: clip(content, MAX_TEXT), context: [] }).ops);
      } else if (role === "assistant") {
        pending = new Map();
        if (content.trim()) {
          ops.push(...this.add({ kind: "assistant", text: clip(content, MAX_TEXT), streaming: false }).ops);
        }
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          if (typeof call?.name !== "string" || call.name === "update_plan") continue;
          const args = parseArguments(call.argumentsJson);
          const summary = toolArgsSummary(args);
          const added = this.add({
            kind: "tool",
            name: clip(call.name, 200),
            title: summary ? `${clip(call.name, 200)} ${summary}` : clip(call.name, 200),
            status: "ok",
            summary: "",
            detail: argsDetail(args),
            output: "",
          });
          ops.push(...added.ops);
          if (typeof call.id === "string") pending.set(call.id, added.item);
        }
      } else if (role === "tool") {
        const item = pending.get(message.toolCallId);
        if (item) {
          pending.delete(message.toolCallId);
          ops.push(...this.update(item, { summary: clipLine(content, 200) || "ok" }));
        }
      }
    }
    return ops;
  }
}

module.exports = { ChatState, MAX_ITEMS, MAX_TEXT, usageView };
