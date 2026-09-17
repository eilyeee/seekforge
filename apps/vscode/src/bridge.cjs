const fs = require("node:fs");
const path = require("node:path");

const MAX_SELECTION_CHARS = 20_000;
/** `seekforge serve` listens here unless --port says otherwise (apps/cli, apps/server). */
const DEFAULT_SERVER_URL = "http://127.0.0.1:7373";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** Tool rows are activity, not transcripts: keep one line readable in the panel. */
const MAX_EVENT_LINE_CHARS = 400;
/** Core bounds refusal feedback to this many characters (MAX_DENIAL_FEEDBACK_CHARS). */
const MAX_FEEDBACK_CHARS = 2_000;
/** The server denies an unanswered permission request or question after this long. */
const SERVER_PROMPT_TIMEOUT_MS = 120_000;
/** The server rejects a history limit above 1000, so never ask for more. */
const MAX_LOOP_HISTORY_ENTRIES = 500;
/** History rows rendered in a report — the most recent ones, where the outcome is. */
const MAX_LOOP_HISTORY_ROWS = 300;
/** Pages one report will walk, so an enormous log cannot stall the editor. */
const MAX_LOOP_HISTORY_PAGES = 20;

function normalizeServerUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SeekForge server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("SeekForge server URL must not include credentials");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function websocketUrl(serverUrl, token) {
  const url = new URL(normalizeServerUrl(serverUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = token ? `?token=${encodeURIComponent(token)}` : "";
  return url.toString();
}

function httpError(status) {
  const error = new Error(`SeekForge HTTP ${status}`);
  error.status = status;
  return error;
}

/**
 * Why a call to the server failed, in the terms the UI acts on: "offline" means
 * nothing is listening (offer to start the server), "unauthorized" means the
 * token is wrong (offer to set it). Anything else is reported as it is.
 */
function connectionProblem(error) {
  if (!error || typeof error !== "object") return "other";
  if (error.status === 401 || error.status === 403) return "unauthorized";
  const codes = [error.code, error.cause?.code, ...(Array.isArray(error.cause?.errors) ? error.cause.errors : [])].map(
    (entry) => (typeof entry === "string" ? entry : entry?.code),
  );
  if (codes.some((code) => code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH")) {
    return "offline";
  }
  // `ws` reports a rejected upgrade as "Unexpected server response: 401".
  if (typeof error.message === "string" && /Unexpected server response: 40[13]\b/.test(error.message)) {
    return "unauthorized";
  }
  return "other";
}

/** True when the URL names this machine over plain http — the only server VS Code can start itself. */
function isLoopbackHttpUrl(serverUrl) {
  try {
    const url = new URL(normalizeServerUrl(serverUrl));
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The port a loopback server URL names (http default 80 when omitted). */
function serverUrlPort(serverUrl) {
  const url = new URL(normalizeServerUrl(serverUrl));
  return url.port === "" ? 80 : Number(url.port);
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function readStoredToken(secretStorage, legacyToken = "") {
  const stored = await secretStorage.get("seekforge.token");
  if (stored) return stored;
  if (!legacyToken) return "";
  await secretStorage.store("seekforge.token", legacyToken);
  return legacyToken;
}

async function writeStoredToken(secretStorage, token) {
  if (token) await secretStorage.store("seekforge.token", token);
  else await secretStorage.delete("seekforge.token");
}

function withWorkspace(pathname, workspaceId) {
  if (!workspaceId) return pathname;
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}ws=${encodeURIComponent(workspaceId)}`;
}

function canonicalWorkspacePath(workspacePath) {
  let resolved = path.resolve(workspacePath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The server may report a path that disappeared after it started.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceRootForEditor(workspaceApi, editor) {
  const uri = editor?.document?.uri;
  const active = uri && workspaceApi?.getWorkspaceFolder?.(uri);
  return active?.uri?.fsPath ?? workspaceApi?.workspaceFolders?.[0]?.uri?.fsPath;
}

/**
 * The raw command/path an approval actually grants. Modal dialogs elide long
 * text, so the diff is shown in its own editor document instead of inlined here
 * — but the raw strings must always stay in front of the approver.
 */
function permissionSummary(request) {
  const rule = request.rememberRule;
  return [
    request.description,
    request.command ? `\nRaw command:\n${request.command}` : "",
    request.path ? `\nRaw path:\n${request.path}` : "",
    // What "Always allow" would write, verbatim. Shown whether or not the
    // approver uses that button — it is the text they are being offered.
    rule ? `\nAlways-allow rule:\n${describeRule(rule)}` : "",
  ].join("");
}

/** The rule as the CLI, TUI and Desktop all print it — never a paraphrase. */
function describeRule(rule) {
  return rule.match === undefined ? `${rule.action} ${rule.tool}` : `${rule.action} ${rule.tool}: ${rule.match}`;
}

/** True when the request carries a diff worth opening in its own document. */
function hasDiffPreview(request) {
  return typeof request?.preview?.diff === "string" && request.preview.diff.length > 0;
}

/** Per-hunk picker rows for multi-hunk apply_patch approvals. */
function permissionHunkItems(request) {
  const hunks = Array.isArray(request?.hunks) ? request.hunks : [];
  if (hunks.length < 2) return [];
  return hunks
    .filter((hunk) => Number.isSafeInteger(hunk?.index) && hunk.index >= 0)
    .map((hunk) => ({
      label: `Hunk ${hunk.index + 1}`,
      detail: clipLine(hunk.preview, 200),
      index: hunk.index,
      picked: true,
    }));
}

/**
 * What an approver may answer, derived only from what core put on the request.
 * "For this session" and "always" both disappear when core says it would not
 * honor a session grant (`sessionGrantable: false` — core would silently
 * downgrade the answer to allow-once), and "always" additionally needs the rule
 * core proposed: a frontend never offers a persistence it made up.
 */
function permissionChoices(request) {
  const grantable = request?.sessionGrantable !== false;
  const rule = request?.rememberRule;
  return {
    allowSession: grantable,
    allowAlways: grantable && typeof rule === "object" && rule !== null && typeof rule.tool === "string",
    hunkIndexes: permissionHunkItems(request).map((item) => item.index),
  };
}

/** A unified diff (as core renders previews) reduced to the lines it adds. */
function addedLines(diff) {
  const lines = diff.split("\n");
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ")) return diff;
  return lines
    .slice(2)
    .filter((line) => line.startsWith("+") || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * The plan an `exit_plan_mode` approval is asking about, as markdown. The plan
 * travels as that request's preview; the field it lands in is read defensively
 * so the reviewer sees the plan rather than a one-line description of it.
 */
function planPreview(request) {
  if (request?.toolName !== "exit_plan_mode") return undefined;
  const preview = request.preview;
  for (const candidate of [request.plan, preview?.plan, preview?.markdown, preview?.content]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  if (typeof preview?.diff === "string" && preview.diff.trim() !== "") return addedLines(preview.diff);
  return undefined;
}

/** Added/removed line counts of a preview diff, headers excluded. */
function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * At most `max` UTF-16 units, ellipsis included, never splitting a surrogate
 * pair. The webview rejects a field longer than its bound, so a clipped value
 * must fit the very bound it was clipped to.
 */
function clipToLength(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  let end = Math.max(0, max - 1);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

const clip = clipToLength;

/**
 * The permission card the chat renders. Raw command and path are carried
 * verbatim (only length-bounded) because the approver must see exactly what
 * the approval grants, never a paraphrase.
 */
function permissionView(requestId, request, receivedAt = Date.now()) {
  const choices = permissionChoices(request);
  const plan = planPreview(request);
  const hasDiff = plan === undefined && hasDiffPreview(request);
  const stats = hasDiff ? diffStats(request.preview.diff) : { added: 0, removed: 0 };
  return {
    requestId,
    toolName: clip(request?.toolName ?? "tool", 200),
    permission: clip(request?.permission ?? "", 40),
    // A plan request repeats the plan in its description for hosts without
    // preview support; the card renders the plan itself, so keep one line.
    description:
      plan === undefined
        ? clip(request?.description ?? "", 4_000)
        : clipLine(String(request?.description ?? "").split("\n")[0], 400),
    ...(typeof request?.command === "string" ? { command: clip(request.command, 400_000) } : {}),
    ...(typeof request?.path === "string" ? { path: clip(request.path, 4_096) } : {}),
    ...(choices.allowAlways ? { rule: clip(describeRule(request.rememberRule), 4_000) } : {}),
    ...(plan !== undefined ? { plan: clip(plan, 400_000) } : {}),
    allowSession: choices.allowSession,
    allowAlways: choices.allowAlways,
    hasDiff,
    escalation: request?.escalation === true,
    added: stats.added,
    removed: stats.removed,
    hunks: permissionHunkItems(request).map((item) => ({ index: item.index, preview: item.detail })),
    expiresAt: receivedAt + SERVER_PROMPT_TIMEOUT_MS,
  };
}

/**
 * Turns a decision from the chat into the `permission.response` frame. It is
 * re-checked here against the request itself, so a UI bug (or a forged webview
 * message) cannot widen an approval: a session or always grant the request did
 * not offer, or a hunk index it did not list, is refused rather than sent.
 */
function permissionResponse(requestId, request, decision, details = {}) {
  const choices = permissionChoices(request);
  switch (decision) {
    case "once":
      return { type: "permission.response", requestId, approved: true };
    case "session":
      if (!choices.allowSession) throw new Error("This request cannot be allowed for the session.");
      return { type: "permission.response", requestId, approved: true, remember: "session" };
    case "always":
      if (!choices.allowAlways) throw new Error("This request cannot be allowed permanently.");
      return { type: "permission.response", requestId, approved: true, remember: "always" };
    case "hunks": {
      const offered = new Set(choices.hunkIndexes);
      const picked = Array.isArray(details.selectedHunks) ? details.selectedHunks : [];
      if (picked.length === 0 || new Set(picked).size !== picked.length || picked.some((i) => !offered.has(i))) {
        throw new Error("Pick at least one of the offered edits.");
      }
      return {
        type: "permission.response",
        requestId,
        approved: true,
        selectedHunks: [...picked].sort((a, b) => a - b),
      };
    }
    case "deny": {
      // Feedback rides along only on a denial; core appends it to the refusal
      // the model reads. Servers that predate it ignore the extra field.
      const feedback = typeof details.feedback === "string" ? details.feedback.trim() : "";
      return {
        type: "permission.response",
        requestId,
        approved: false,
        ...(feedback ? { feedback: feedback.slice(0, MAX_FEEDBACK_CHARS) } : {}),
      };
    }
    default:
      throw new Error(`Unknown permission decision: ${String(decision)}`);
  }
}

function clipLine(text, max = MAX_EVENT_LINE_CHARS) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // Array.from splits by code point, so clipping never severs a surrogate pair.
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max).join("")}…`;
}

/** The single most identifying argument of a tool call, for the activity row. */
function toolArgsSummary(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "agentId", "id"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return clipLine(value, 160);
  }
  try {
    return clipLine(JSON.stringify(args), 160);
  } catch {
    return "";
  }
}

function toolResultSummary(result) {
  if (!result || typeof result !== "object") return "";
  if (result.ok === false) {
    return `error: ${clipLine(result.error?.message ?? result.error?.code ?? "failed", 200)}`;
  }
  const data = result.data;
  if (typeof data === "string") return clipLine(data, 200);
  if (data === undefined || data === null) return "ok";
  try {
    return clipLine(JSON.stringify(data), 200);
  } catch {
    return "ok";
  }
}

function formatTokens(count) {
  const value = Number(count) || 0;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Cost first: DeepSeek cache-hit accounting is a first-class part of the product. */
function usageSummary(usage) {
  if (!usage || typeof usage !== "object") return "";
  const cached = Number(usage.cacheHitTokens) || 0;
  const prompt = `${formatTokens(usage.promptTokens)} prompt${cached ? ` (${formatTokens(cached)} cached)` : ""}`;
  return `$${(Number(usage.costUsd) || 0).toFixed(4)} · ${prompt} · ${formatTokens(usage.completionTokens)} completion`;
}

/** Persisted Loop statuses that have not settled yet (server LoopPersistedStatus). */
const ACTIVE_LOOP_STATUSES = new Set(["running", "paused"]);

/**
 * Reader-facing grouping of a persisted Loop status. The server owns the
 * vocabulary; this only buckets it for display, and anything unrecognised falls
 * into "fail" rather than being rendered as a success the server never claimed.
 */
function loopOutcome(status) {
  if (ACTIVE_LOOP_STATUSES.has(status)) return "active";
  if (status === "passed") return "pass";
  if (status === "cancelled") return "cancelled";
  if (status === "requirements_pending") return "pending";
  return "fail";
}

function formatUsd(value) {
  return `$${(Number(value) || 0).toFixed(4)}`;
}

/** "3/10" — iterations run against the configured ceiling. */
function loopProgress(loop) {
  const done = Number(loop?.iterations) || 0;
  const max = Number(loop?.maxIterations);
  return Number.isFinite(max) && max > 0 ? `${done}/${max}` : String(done);
}

/** Spend, with the budget appended only when the Loop actually has one. */
function loopCost(loop) {
  const budget = loop?.costBudgetUsd;
  const spent = formatUsd(loop?.costUsd);
  return typeof budget === "number" && Number.isFinite(budget) ? `${spent} / ${formatUsd(budget)}` : spent;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** One list row for a persisted Loop: what it is, where it got to, what it cost. */
function loopRow(loop) {
  const status = typeof loop?.status === "string" && loop.status ? loop.status : "unknown";
  return {
    loopId: typeof loop?.loopId === "string" ? loop.loopId : "",
    outcome: loopOutcome(status),
    label: clipLine(loop?.task || loop?.loopId || "loop", 120),
    description: `${status} · ${loopProgress(loop)} · ${loopCost(loop)}`,
    detail: [loop?.loopId, loop?.phase ? `phase ${loop.phase}` : "", loop?.updatedAt ? `updated ${loop.updatedAt}` : ""]
      .filter((part) => part)
      .join(" · "),
  };
}

/** Last `maxLines` lines of captured output, for a bounded excerpt in the report. */
function outputTail(output, maxLines = 40) {
  const lines = String(output ?? "")
    .split("\n")
    .filter((line, index, all) => line.trim() !== "" || index < all.length - 1);
  return lines.slice(-maxLines).join("\n").trimEnd();
}

/**
 * A code fence longer than the longest backtick run inside the body, so a
 * verify command or captured output containing ``` cannot break out of
 * its block and rewrite the rest of the report.
 */
function fencedBlock(language, body) {
  const longest = (String(body).match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, body, fence];
}

/**
 * One retained Loop history entry as a readable line. Unknown event types are
 * still printed by name: a history that silently drops rows would misrepresent
 * what the Loop did.
 */
function formatLoopEvent(event) {
  if (!event || typeof event.type !== "string") return "unknown event";
  switch (event.type) {
    case "iteration.start":
      return `iteration ${event.iteration} started`;
    case "run.completed":
      return `iteration ${event.iteration} agent run completed (${formatUsd(event.costUsd)})`;
    case "verify":
      return `iteration ${event.iteration} verify exit ${event.code} — ${event.passed ? "passed" : "failed"}`;
    case "verify.stage.started":
      return `iteration ${event.iteration} stage ${event.stageId} attempt ${event.attempt}`;
    case "verify.stage.completed":
      return `iteration ${event.iteration} stage ${event.result?.id} exit ${event.result?.code}${
        event.result?.flaky ? " (flaky)" : ""
      }`;
    case "verify.flaky":
      return `iteration ${event.iteration} stage ${event.stageId} flaky after ${event.attempts} attempts`;
    case "loop.model.routed":
      return `iteration ${event.iteration} routed ${event.category} to ${event.model} after ${event.consecutiveFailures} failures${
        event.reason === "escalated_category" ? " (escalated)" : ""
      }`;
    case "verify.impact":
      return `iteration ${event.iteration} impact selection${event.fullFallback ? " (full fallback)" : ""}`;
    case "loop.paused":
      return `iteration ${event.iteration} paused`;
    case "loop.resumed":
      return `iteration ${event.iteration} resumed`;
    case "loop.steered":
      return `iteration ${event.iteration} steered (${event.count} message(s))`;
    case "loop.recovery":
      return `iteration ${event.iteration} recovery attempt ${event.attempt} (${event.reason})`;
    case "loop.rollback":
      return `iteration ${event.iteration} rolled back (${(event.restored ?? []).length} restored, ${
        (event.deleted ?? []).length
      } deleted)`;
    case "requirements.completed":
      return `requirements ready${event.approvalRequired ? " — approval required" : ""}`;
    case "requirements.reviewed":
      return `acceptance review ${event.review?.complete ? "complete" : "incomplete"}`;
    case "code_review.completed":
      return `iteration ${event.iteration} code review: ${clipLine(event.review?.summary ?? "", 160)}`;
    case "loop.warning":
      return `warning (${event.warning}): ${clipLine(event.message, 200)}`;
    case "loop.done":
      return `done — ${event.result?.status} after ${event.result?.iterations} iteration(s), ${formatUsd(
        event.result?.costUsd,
      )}`;
    default:
      return event.type;
  }
}

/**
 * A persisted Loop rendered for reading: what it was asked to do, how far it
 * got, what it spent, and the retained lifecycle log. Read-only by design —
 * pausing, steering and deleting a Loop stay with the surfaces that own the
 * control plane.
 */
function formatLoopReport(loop, history = [], options = {}) {
  const lines = [`# ${loop?.task || loop?.loopId || "SeekForge loop"}`, ""];
  lines.push(`- **Loop**: \`${loop?.loopId ?? "?"}\``);
  lines.push(`- **Status**: ${loop?.status ?? "unknown"}${loop?.phase ? ` (phase ${loop.phase})` : ""}`);
  lines.push(`- **Iterations**: ${loopProgress(loop)}`);
  lines.push(`- **Cost**: ${loopCost(loop)}`);
  if (typeof loop?.tokensUsed === "number") {
    lines.push(
      `- **Tokens**: ${formatTokens(loop.tokensUsed)}${
        typeof loop?.tokenBudget === "number" ? ` / ${formatTokens(loop.tokenBudget)}` : ""
      }`,
    );
  }
  if (typeof loop?.elapsedMs === "number") lines.push(`- **Elapsed**: ${formatDuration(loop.elapsedMs)}`);
  if (typeof loop?.verifyRuns === "number") lines.push(`- **Verify runs**: ${loop.verifyRuns}`);
  if (loop?.createdAt) lines.push(`- **Created**: ${loop.createdAt}`);
  if (loop?.updatedAt) lines.push(`- **Updated**: ${loop.updatedAt}`);
  if (loop?.verifyCommand) lines.push("", "## Verify command", "", ...fencedBlock("sh", loop.verifyCommand));
  if (loop?.delivery) {
    lines.push(
      "",
      "## Delivery",
      "",
      `- ${loop.delivery.mode} — ${loop.delivery.status}${loop.delivery.phase ? ` (${loop.delivery.phase})` : ""}`,
      ...(loop.delivery.artifact ? [`- artifact: ${loop.delivery.artifact}`] : []),
      ...(loop.delivery.error ? [`- error: ${clipLine(loop.delivery.error, 300)}`] : []),
    );
  }
  if (loop?.lastVerify) {
    const tail = outputTail(loop.lastVerify.output);
    lines.push("", `## Last verify (exit ${loop.lastVerify.code})`, "");
    lines.push(...(tail ? fencedBlock("txt", tail) : ["_no output_"]));
  }
  if (loop?.lastAgentError) {
    lines.push(
      "",
      "## Last agent error",
      "",
      `\`${loop.lastAgentError.code ?? "error"}\` — ${clipLine(loop.lastAgentError.message ?? "", 400)}`,
    );
  }
  lines.push("", "## History", "");
  // The wire contract only pages forward, so a long log is read as a tail. Say
  // what was left out: a partial history presented as complete would hide the
  // very events — the failure, the final loop.done — a reader opened this for.
  const dropped = Number(options.dropped) || 0;
  if (dropped > 0 || options.truncated) {
    const total = `${dropped + history.length}${options.truncated ? "+" : ""}`;
    lines.push(`_Showing the ${history.length} most recent of ${total} retained events._`, "");
  }
  // "Could not read it" and "there is none" are different facts about the loop.
  if (options.error) {
    const reason = options.error instanceof Error ? options.error.message : String(options.error);
    lines.push(`_History could not be read: ${clipLine(reason, 200)}._`);
  } else if (history.length === 0) {
    lines.push("_No retained history for this loop._");
  }
  for (const entry of history)
    lines.push(`- \`${entry?.seq ?? "?"}\` ${entry?.ts ?? ""} — ${formatLoopEvent(entry?.event)}`);
  return lines.join("\n");
}

/**
 * Renders one agent event as an output-channel line, or null when the event
 * carries no standalone row (streamed deltas and usage updates are handled by
 * the caller, which appends them without a line break or shows them elsewhere).
 */
function formatAgentEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  switch (event.type) {
    case "tool.started":
      return `⏺ ${event.toolName}(${toolArgsSummary(event.args)})`;
    case "tool.completed":
      return `  ⎿ ${toolResultSummary(event.result) || "ok"}`;
    case "file.changed":
      return `  ± ${event.path}`;
    case "notice":
      return `${event.level === "warn" ? "!" : "i"} ${clipLine(event.message)}`;
    case "context.compacted":
      return `  ⎿ context compacted (${event.droppedTurns} turns, ${formatTokens(event.summaryTokens)} summary tokens)`;
    case "context.microcompacted":
      return `  ⎿ context micro-compacted (${event.clearedResults} tool results cleared)`;
    case "provider.retry":
      return `⟳ provider retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms — ${clipLine(event.reason, 120)}`;
    case "subagent.started":
      return `⏺ subagent ${event.agentId}: ${clipLine(event.task, 160)}`;
    case "subagent.step":
      return `  ⎿ subagent ${event.agentId} → ${event.toolName}`;
    case "subagent.completed":
      return `  ⎿ subagent ${event.agentId} done: ${clipLine(event.resultSummary, 200)}`;
    case "subagent.failed":
      return `  ⎿ subagent ${event.agentId} failed: ${clipLine(event.error?.message ?? "failed", 200)}`;
    case "subagent.cancelled":
      return `  ⎿ subagent ${event.agentId} cancelled: ${clipLine(event.reason, 160)}`;
    case "session.created":
      return `\nSession: ${event.sessionId}\n`;
    case "session.completed": {
      const report = event.report ?? {};
      const changed = Array.isArray(report.changedFiles) ? report.changedFiles : [];
      return [
        "",
        `⏺ ${clipLine(report.summary, 600)}`,
        changed.length > 0 ? `  ⎿ changed: ${changed.join(", ")}` : "",
        report.verification ? `  ⎿ verification: ${clipLine(report.verification, 200)}` : "",
        `  ⎿ usage: ${usageSummary(report.usage)}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "session.failed":
      return `\nError: ${clipLine(event.error?.message ?? "run failed", 400)}`;
    default:
      return null;
  }
}

class SeekForgeBridge {
  constructor({
    serverUrl,
    token,
    WebSocketImpl,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
  }

  /**
   * One REST call. `method`/`body` are for the few routes that change something
   * (approving a remembered fact); everything else is a plain GET.
   */
  async request(pathname, options = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(abortError("SeekForge request timed out")), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serverUrl}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!response.ok) throw httpError(response.status);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw abortError("SeekForge request was cancelled or timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async workspaceId(workspacePath) {
    if (!workspacePath) throw new Error("Open a workspace folder before connecting to SeekForge");
    const body = await this.request("/api/workspaces");
    const wanted = canonicalWorkspacePath(workspacePath);
    const match = body.workspaces?.find(
      (workspace) => typeof workspace.path === "string" && canonicalWorkspacePath(workspace.path) === wanted,
    );
    if (typeof match?.id !== "string" || match.id.length === 0) {
      throw new Error(`SeekForge server does not host the VS Code workspace: ${workspacePath}`);
    }
    return match.id;
  }

  /**
   * Facts waiting for a human decision. Memory is human-gated by design, so the
   * queue is only useful where the reviewer already is — which, while coding,
   * is the editor rather than another app.
   */
  async pendingMemory(workspaceId, options = {}) {
    const body = await this.request(withWorkspace("/api/memory", workspaceId), options);
    const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
    return candidates.filter((candidate) => candidate?.status === "pending");
  }

  async decideMemory(workspaceId, id, decision, options = {}) {
    if (decision !== "approve" && decision !== "reject") throw new Error(`Unknown memory decision: ${decision}`);
    return this.request(withWorkspace(`/api/memory/${encodeURIComponent(id)}/${decision}`, workspaceId), {
      ...options,
      method: "POST",
    });
  }

  /**
   * Stored sessions, newest first. The server answers with a bare array
   * (`listSessions`); an older client read `body.sessions` and so always
   * reported "no sessions". The object form is still accepted.
   */
  async sessions(workspaceId, options = {}) {
    const body = await this.request(withWorkspace("/api/sessions", workspaceId), options);
    const list = Array.isArray(body) ? body : Array.isArray(body?.sessions) ? body.sessions : [];
    return list.filter((session) => typeof session?.id === "string" && session.id.length > 0);
  }

  /** Workspace-relative paths matching `query`, for the chat's @-mention picker. */
  async files(workspaceId, query, options = {}) {
    const pathname = `/api/files?q=${encodeURIComponent(query)}`;
    const body = await this.request(withWorkspace(pathname, workspaceId), options);
    return Array.isArray(body?.files) ? body.files.filter((file) => typeof file === "string") : [];
  }

  /**
   * Persisted Loops for a workspace, newest first. The server returns a bare
   * array; anything else is treated as "none" rather than crashing the view.
   */
  async loops(workspaceId, options = {}) {
    const body = await this.request(withWorkspace("/api/loops", workspaceId), options);
    return Array.isArray(body) ? body : [];
  }

  async loop(workspaceId, id, options = {}) {
    return this.request(withWorkspace(`/api/loops/${encodeURIComponent(id)}`, workspaceId), options);
  }

  /**
   * Retained lifecycle log after `after` (exclusive). The server caps `limit` at
   * 1000, so asking for more would be a 400 rather than more history.
   */
  async loopHistory(workspaceId, id, options = {}) {
    const { after = 0, limit = MAX_LOOP_HISTORY_ENTRIES, ...rest } = options;
    const query = `/api/loops/${encodeURIComponent(id)}/history?after=${after}&limit=${limit}`;
    const body = await this.request(withWorkspace(query, workspaceId), rest);
    return Array.isArray(body) ? body : [];
  }

  /**
   * The MOST RECENT retained history. The wire contract only pages forward from
   * a sequence cursor — there is no "tail" parameter — so a reader who stopped
   * at the first page would see a long Loop's opening events and never its
   * failure or its final `loop.done`. Walk forward, keep the tail, and report
   * what was dropped so the caller can say the log is partial.
   *
   * Paging stops on a short page, on a cursor that fails to advance (a server
   * that cannot page further must not spin this loop), and at `maxPages`.
   */
  async loopHistoryTail(workspaceId, id, options = {}) {
    // `limit` is read here rather than passed through untouched: the end-of-log
    // test compares a page against the size that was actually requested.
    const {
      rows = MAX_LOOP_HISTORY_ROWS,
      maxPages = MAX_LOOP_HISTORY_PAGES,
      limit = MAX_LOOP_HISTORY_ENTRIES,
      ...rest
    } = options;
    const entries = [];
    let dropped = 0;
    let truncated = false;
    let after = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.loopHistory(workspaceId, id, { ...rest, after, limit });
      for (const entry of batch) {
        entries.push(entry);
        if (entries.length > rows) {
          entries.shift();
          dropped += 1;
        }
      }
      const last = batch.length > 0 ? Number(batch[batch.length - 1]?.seq) : Number.NaN;
      if (batch.length < limit || !Number.isFinite(last) || last <= after) break;
      after = last;
      truncated = page + 1 >= maxPages;
    }
    return { entries, dropped, truncated };
  }

  /** One session's transcript, as the messages a reader would want to see. */
  async sessionTranscript(workspaceId, id, options = {}) {
    const body = await this.request(withWorkspace(`/api/sessions/${encodeURIComponent(id)}`, workspaceId), options);
    return {
      meta: body?.meta ?? {},
      messages: Array.isArray(body?.messages) ? body.messages : [],
    };
  }

  run(frame, onFrame, options = {}) {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(websocketUrl(this.serverUrl, this.token));
      let settled = false;
      let opened = false;
      const timer = setTimeout(() => finish(abortError("SeekForge run timed out")), this.runTimeoutMs);
      const onAbort = () => {
        if (opened) {
          try {
            socket.send(JSON.stringify({ type: "cancel" }));
          } catch {
            // Closing below still releases the local connection.
          }
        }
        finish(abortError("SeekForge run cancelled"));
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("open", () => {
        opened = true;
        socket.send(JSON.stringify(frame));
      });
      socket.on("message", async (data) => {
        // A closing socket can still deliver frames; they belong to a run
        // this caller has already been told is over.
        if (settled) return;
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        try {
          await onFrame(message, (reply) => socket.send(JSON.stringify(reply)));
        } catch (error) {
          finish(error);
          return;
        }
        if (message.type === "idle") finish();
        // A late answer to a prompt the server already timed out is refused with
        // `unknown_request`; the run itself goes on, so the client must too.
        if (message.type === "error" && message.code !== "unknown_request") {
          const error = new Error(message.message);
          error.code = message.code;
          finish(error);
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        if (!settled) finish(new Error("SeekForge WebSocket closed before the run completed"));
      });
    });
  }
}

/**
 * Render a transcript for reading, not for replay: roles as headers, tool calls
 * named rather than dumped. A reviewer opening a past session wants to see what
 * happened, and the raw JSONL is the thing they were trying to avoid.
 */
function formatTranscript(meta, messages) {
  const lines = [`# ${meta?.title || meta?.id || "SeekForge session"}`];
  if (meta?.createdAt) lines.push(`_${meta.createdAt}_`);
  for (const message of messages) {
    const role = String(message?.role ?? "");
    if (role === "system") continue; // the prompt, not the conversation
    const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    const header = role === "tool" ? "tool result" : role;
    lines.push("", `## ${header}`);
    const content = typeof message?.content === "string" ? message.content : "";
    if (content) lines.push(content);
    for (const call of calls) lines.push(`- called \`${call?.name ?? "?"}\``);
    const images = Array.isArray(message?.images) ? message.images : [];
    // The bytes are not printable, but their absence would misrepresent the
    // turn: the model saw something this reader cannot.
    for (const image of images) lines.push(`- [image attached: ${image?.label ?? image?.mediaType ?? "image"}]`);
  }
  return lines.join("\n");
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_SERVER_URL,
  MAX_EVENT_LINE_CHARS,
  MAX_FEEDBACK_CHARS,
  MAX_LOOP_HISTORY_ENTRIES,
  MAX_LOOP_HISTORY_PAGES,
  MAX_LOOP_HISTORY_ROWS,
  MAX_SELECTION_CHARS,
  SERVER_PROMPT_TIMEOUT_MS,
  SeekForgeBridge,
  canonicalWorkspacePath,
  clipLine,
  clipToLength,
  connectionProblem,
  describeRule,
  diffStats,
  fencedBlock,
  formatAgentEvent,
  formatDuration,
  formatLoopEvent,
  formatLoopReport,
  formatTranscript,
  formatTokens,
  hasDiffPreview,
  isLoopbackHttpUrl,
  loopCost,
  loopOutcome,
  loopProgress,
  loopRow,
  normalizeServerUrl,
  permissionChoices,
  permissionHunkItems,
  permissionResponse,
  permissionSummary,
  permissionView,
  planPreview,
  readStoredToken,
  serverUrlPort,
  toolArgsSummary,
  toolResultSummary,
  usageSummary,
  websocketUrl,
  withWorkspace,
  workspaceRootForEditor,
  writeStoredToken,
};
