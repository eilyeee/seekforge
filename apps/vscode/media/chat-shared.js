// Shared by the extension host (required as CommonJS) and the chat webview
// (loaded as a classic script, where it becomes `globalThis.SeekForgeChat`).
// It owns the two things both sides must agree on: the postMessage protocol,
// validated strictly in each direction, and the markdown subset the webview
// renders. Markdown is parsed into a plain tree that the webview turns into DOM
// nodes with `textContent`, so no string from the model, a tool, or the server
// is ever interpreted as HTML.
//
// Constraint: this file runs unbundled in two runtimes, so it uses no imports,
// no Node or DOM APIs, and only syntax both runtimes accept.
(function (factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else globalThis.SeekForgeChat = Object.freeze(api);
})(function () {
  const MODES = ["ask", "edit", "plan"];
  const APPROVAL_MODES = ["confirm", "acceptEdits", "auto"];
  const DECISIONS = ["once", "session", "always", "deny", "hunks"];
  const NOTICE_LEVELS = ["info", "warn", "error"];
  const ITEM_KINDS = [
    "user",
    "assistant",
    "thinking",
    "tool",
    "file",
    "notice",
    "subagent",
    "report",
    "failed",
    "plan",
  ];
  const TOOL_STATUSES = ["running", "ok", "error"];
  const SUBAGENT_STATUSES = ["running", "done", "failed", "cancelled"];
  const PLAN_STATUSES = ["pending", "in_progress", "done"];

  const LIMITS = Object.freeze({
    /** A prompt larger than this cannot fit the server's 1 MB frame once context is added. */
    promptChars: 200_000,
    /** Core bounds refusal feedback to the same length (MAX_DENIAL_FEEDBACK_CHARS). */
    feedbackChars: 2_000,
    answerChars: 20_000,
    queryChars: 200,
    pathChars: 4_096,
    idChars: 128,
    hunks: 10_000,
    itemText: 400_000,
    items: 1_000,
    shortText: 4_000,
    listEntries: 500,
    markdownChars: 400_000,
    markdownBlocks: 5_000,
    markdownDepth: 4,
  });

  const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const isString = (value, max, min = 0) => typeof value === "string" && value.length >= min && value.length <= max;
  const isBool = (value) => typeof value === "boolean";
  const isCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const optional = (value, check) => value === undefined || check(value);
  const hasOnly = (record, keys) => Object.keys(record).every((key) => keys.includes(key));

  function fail(error) {
    return { ok: false, error };
  }

  /** Distinct non-negative safe integers, as the server's decoder requires. */
  function isHunkList(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.hunks) return false;
    const seen = new Set();
    for (const index of value) {
      if (!isCount(index) || seen.has(index)) return false;
      seen.add(index);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // webview -> host
  // ---------------------------------------------------------------------------

  const WEBVIEW_MESSAGES = {
    ready: [],
    stop: [],
    newSession: [],
    listSessions: [],
    addSelection: [],
    executePlan: [],
    openInEditor: [],
    send: ["text", "mode", "approvalMode", "includeContext"],
    setOptions: ["mode", "approvalMode", "includeContext"],
    resumeSession: ["sessionId"],
    permission: ["requestId", "decision", "selectedHunks", "feedback"],
    openReviewDiff: ["requestId"],
    question: ["id", "answer"],
    searchFiles: ["query"],
    openFile: ["path"],
  };

  /**
   * Decodes one message the webview posted. The webview is our own code, but it
   * renders untrusted text, so the host treats its messages like any other
   * transport input: unknown types, unknown fields, and out-of-domain values
   * are rejected rather than coerced.
   */
  function decodeWebviewMessage(message) {
    if (!isRecord(message) || typeof message.type !== "string") return fail("message must be an object with a type");
    if (!Object.hasOwn(WEBVIEW_MESSAGES, message.type)) return fail(`unknown message type: ${message.type}`);
    if (!hasOnly(message, ["type", ...WEBVIEW_MESSAGES[message.type]])) {
      return fail(`${message.type} has unsupported fields`);
    }
    if (message.type === "send" || message.type === "setOptions") {
      if (message.type === "send" && (!isString(message.text, LIMITS.promptChars, 1) || message.text.trim() === "")) {
        return fail("send.text must be a non-empty prompt");
      }
      if (!MODES.includes(message.mode)) return fail("mode must be ask, edit, or plan");
      if (!APPROVAL_MODES.includes(message.approvalMode)) {
        return fail("approvalMode must be confirm, acceptEdits, or auto");
      }
      if (!isBool(message.includeContext)) return fail("includeContext must be a boolean");
    }
    switch (message.type) {
      case "resumeSession":
        if (!isString(message.sessionId, LIMITS.idChars) || !SESSION_ID_RE.test(message.sessionId)) {
          return fail("resumeSession.sessionId is not a session id");
        }
        break;
      case "permission":
        if (!isString(message.requestId, 64) || !REQUEST_ID_RE.test(message.requestId)) {
          return fail("permission.requestId is not a request id");
        }
        if (!DECISIONS.includes(message.decision)) return fail("permission.decision is unknown");
        // Hunks belong to exactly one decision: a stray list on an allow-all or a
        // deny would otherwise be a second, contradictory answer.
        if (message.decision === "hunks" ? !isHunkList(message.selectedHunks) : message.selectedHunks !== undefined) {
          return fail("permission.selectedHunks must be a distinct index list, and only for a hunks decision");
        }
        if (message.feedback !== undefined) {
          if (message.decision !== "deny") return fail("permission.feedback is only sent with a denial");
          if (!isString(message.feedback, LIMITS.feedbackChars)) {
            return fail(`permission.feedback must be at most ${LIMITS.feedbackChars} characters`);
          }
        }
        break;
      case "openReviewDiff":
        if (!isString(message.requestId, 64) || !REQUEST_ID_RE.test(message.requestId)) {
          return fail("openReviewDiff.requestId is not a request id");
        }
        break;
      case "question":
        if (!isString(message.id, 64) || !REQUEST_ID_RE.test(message.id)) return fail("question.id is not an id");
        if (!isString(message.answer, LIMITS.answerChars)) return fail("question.answer is too long");
        break;
      case "searchFiles":
        if (!isString(message.query, LIMITS.queryChars)) return fail("searchFiles.query is too long");
        break;
      case "openFile":
        if (!isString(message.path, LIMITS.pathChars, 1) || message.path.includes("\0")) {
          return fail("openFile.path is not a path");
        }
        break;
      default:
        break;
    }
    return { ok: true, message };
  }

  // ---------------------------------------------------------------------------
  // host -> webview
  // ---------------------------------------------------------------------------

  function isUsage(value) {
    return (
      isRecord(value) &&
      isFiniteNumber(value.costUsd) &&
      isCount(value.promptTokens) &&
      isCount(value.completionTokens) &&
      isCount(value.cacheHitTokens)
    );
  }

  function isStringList(value, maxEntries, maxChars) {
    return Array.isArray(value) && value.length <= maxEntries && value.every((entry) => isString(entry, maxChars));
  }

  function isItem(item) {
    if (!isRecord(item) || !isCount(item.id) || !ITEM_KINDS.includes(item.kind)) return false;
    switch (item.kind) {
      case "user":
        return isString(item.text, LIMITS.itemText) && optional(item.context, (v) => isStringList(v, 50, 300));
      case "assistant":
      case "thinking":
        return isString(item.text, LIMITS.itemText) && isBool(item.streaming);
      case "tool":
        return (
          isString(item.name, 200) &&
          isString(item.title, LIMITS.shortText) &&
          TOOL_STATUSES.includes(item.status) &&
          isString(item.summary, LIMITS.shortText) &&
          isString(item.detail, LIMITS.shortText) &&
          isString(item.output, LIMITS.shortText)
        );
      case "file":
        return isString(item.path, LIMITS.pathChars);
      case "notice":
        return NOTICE_LEVELS.includes(item.level) && isString(item.text, LIMITS.shortText);
      case "subagent":
        return (
          isString(item.agentId, 200) &&
          isString(item.task, LIMITS.shortText) &&
          SUBAGENT_STATUSES.includes(item.status) &&
          isString(item.detail, LIMITS.shortText)
        );
      case "report":
        return (
          isString(item.summary, LIMITS.itemText) &&
          isStringList(item.changedFiles, LIMITS.listEntries, LIMITS.pathChars) &&
          isString(item.verification, LIMITS.shortText) &&
          (item.usage === null || isUsage(item.usage))
        );
      case "failed":
        return isString(item.message, LIMITS.shortText);
      case "plan":
        return (
          Array.isArray(item.steps) &&
          item.steps.length <= 100 &&
          item.steps.every(
            (step) => isRecord(step) && isString(step.step, 1_000) && PLAN_STATUSES.includes(step.status),
          )
        );
      default:
        return false;
    }
  }

  function isStatus(status) {
    return (
      isRecord(status) &&
      isBool(status.running) &&
      (status.sessionId === null || isString(status.sessionId, LIMITS.idChars)) &&
      (status.usage === null || isUsage(status.usage)) &&
      (status.contextPercent === null || isFiniteNumber(status.contextPercent)) &&
      isBool(status.planReady) &&
      (status.workspace === null || isString(status.workspace, LIMITS.pathChars)) &&
      (status.activity === null || isString(status.activity, LIMITS.shortText))
    );
  }

  function isPermissionView(view) {
    return (
      isRecord(view) &&
      isString(view.requestId, 64) &&
      isString(view.toolName, 200) &&
      isString(view.permission, 40) &&
      isString(view.description, LIMITS.shortText) &&
      optional(view.command, (v) => isString(v, LIMITS.itemText)) &&
      optional(view.path, (v) => isString(v, LIMITS.pathChars)) &&
      optional(view.rule, (v) => isString(v, LIMITS.shortText)) &&
      optional(view.plan, (v) => isString(v, LIMITS.itemText)) &&
      isBool(view.allowSession) &&
      isBool(view.allowAlways) &&
      isBool(view.hasDiff) &&
      isBool(view.escalation) &&
      isCount(view.added) &&
      isCount(view.removed) &&
      isCount(view.expiresAt) &&
      Array.isArray(view.hunks) &&
      view.hunks.length <= LIMITS.hunks &&
      view.hunks.every((hunk) => isRecord(hunk) && isCount(hunk.index) && isString(hunk.preview, LIMITS.shortText))
    );
  }

  function isQuestionView(view) {
    return (
      isRecord(view) &&
      isString(view.id, 64) &&
      isString(view.question, LIMITS.shortText) &&
      isStringList(view.options, 50, LIMITS.shortText) &&
      isBool(view.freeText) &&
      isCount(view.expiresAt)
    );
  }

  function isSessionRow(row) {
    return (
      isRecord(row) &&
      isString(row.id, LIMITS.idChars) &&
      isString(row.title, LIMITS.shortText) &&
      isString(row.updatedAt, 100) &&
      isString(row.status, 40)
    );
  }

  function isOptions(options) {
    return (
      isRecord(options) &&
      MODES.includes(options.mode) &&
      APPROVAL_MODES.includes(options.approvalMode) &&
      isBool(options.includeContext)
    );
  }

  /**
   * Validates a host message inside the webview. Everything in it was derived
   * from server frames, so the webview checks shape before it touches the DOM;
   * a message that fails is dropped whole.
   */
  function decodeHostMessage(message) {
    if (!isRecord(message) || typeof message.type !== "string") return fail("message must be an object with a type");
    switch (message.type) {
      case "reset":
        if (
          !Array.isArray(message.items) ||
          message.items.length > LIMITS.items ||
          !message.items.every(isItem) ||
          !isStatus(message.status) ||
          !(message.permission === null || isPermissionView(message.permission)) ||
          !(message.question === null || isQuestionView(message.question)) ||
          !isOptions(message.options)
        ) {
          return fail("malformed reset");
        }
        break;
      case "upsert":
        if (!isItem(message.item)) return fail("malformed item");
        break;
      case "append":
        if (!isCount(message.id) || !isString(message.text, LIMITS.itemText)) return fail("malformed append");
        break;
      case "status":
        if (!isStatus(message.status)) return fail("malformed status");
        break;
      case "permission":
        if (!(message.pending === null || isPermissionView(message.pending))) return fail("malformed permission");
        break;
      case "question":
        if (!(message.pending === null || isQuestionView(message.pending))) return fail("malformed question");
        break;
      case "sessions":
        if (
          !Array.isArray(message.sessions) ||
          message.sessions.length > LIMITS.listEntries ||
          !message.sessions.every(isSessionRow)
        ) {
          return fail("malformed sessions");
        }
        break;
      case "files":
        if (
          !isString(message.query, LIMITS.queryChars) ||
          !isStringList(message.files, LIMITS.listEntries, LIMITS.pathChars)
        ) {
          return fail("malformed files");
        }
        break;
      case "insertText":
        if (!isString(message.text, LIMITS.promptChars, 1)) return fail("malformed insertText");
        break;
      case "notice":
        if (!NOTICE_LEVELS.includes(message.level) || !isString(message.message, LIMITS.shortText)) {
          return fail("malformed notice");
        }
        break;
      case "focus":
        break;
      default:
        return fail(`unknown message type: ${message.type}`);
    }
    return { ok: true, message };
  }

  // ---------------------------------------------------------------------------
  // Markdown -> tree
  // ---------------------------------------------------------------------------

  const SAFE_URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;
  const LANGUAGE_RE = /^[A-Za-z0-9_+#.-]{1,32}$/;

  function safeUrl(url) {
    return SAFE_URL_RE.test(url) ? url : null;
  }

  /**
   * Inline markdown as a node list. Recognised: code spans, links (http/https
   * only), bare http/https URLs, **strong**, *emphasis*, ~~strike~~, and hard
   * line breaks. Anything else stays literal text.
   */
  function parseInline(text, depth = 0) {
    const nodes = [];
    let plain = "";
    const flush = () => {
      if (plain) nodes.push({ t: "text", v: plain });
      plain = "";
    };
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\n") {
        flush();
        nodes.push({ t: "br" });
        i += 1;
        continue;
      }
      if (ch === "`") {
        let run = 0;
        while (text[i + run] === "`") run += 1;
        const fence = "`".repeat(run);
        const close = text.indexOf(fence, i + run);
        // A closing run must be exactly as long as the opening one.
        if (close !== -1 && text[close + run] !== "`") {
          flush();
          nodes.push({ t: "code", v: text.slice(i + run, close).replace(/^ (.+) $/s, "$1") });
          i = close + run;
          continue;
        }
        plain += fence;
        i += run;
        continue;
      }
      if (depth < LIMITS.markdownDepth && ch === "[") {
        const closeText = text.indexOf("](", i + 1);
        const closeUrl = closeText === -1 ? -1 : text.indexOf(")", closeText + 2);
        if (closeText !== -1 && closeUrl !== -1 && !text.slice(i + 1, closeText).includes("\n")) {
          const href = safeUrl(text.slice(closeText + 2, closeUrl).trim());
          if (href) {
            flush();
            nodes.push({ t: "a", href, c: parseInline(text.slice(i + 1, closeText), depth + 1) });
            i = closeUrl + 1;
            continue;
          }
        }
      }
      if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 8))) {
        const match = /^https?:\/\/[^\s<>"'`]+/i.exec(text.slice(i));
        // Trailing sentence punctuation belongs to the prose, not the URL.
        const url = match ? match[0].replace(/[.,;:!?)\]]+$/, "") : "";
        if (url.length > 8 && (i === 0 || /[\s(]/.test(text[i - 1]))) {
          flush();
          nodes.push({ t: "a", href: url, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
      if (depth < LIMITS.markdownDepth && (ch === "*" || ch === "_" || ch === "~")) {
        const double = text[i + 1] === ch;
        const marker = double ? ch + ch : ch;
        const tag = ch === "~" ? (double ? "s" : null) : double ? "b" : "i";
        // `_` inside a word (snake_case) is not emphasis.
        const wordBoundary = ch !== "_" || i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]);
        if (tag && wordBoundary && text[i + marker.length] && !/\s/.test(text[i + marker.length])) {
          const close = text.indexOf(marker, i + marker.length);
          if (
            close > i + marker.length &&
            !/\s/.test(text[close - 1]) &&
            (ch !== "_" || !/[A-Za-z0-9]/.test(text[close + marker.length] ?? "")) &&
            !text.slice(i + marker.length, close).includes("\n\n")
          ) {
            flush();
            nodes.push({ t: tag, c: parseInline(text.slice(i + marker.length, close), depth + 1) });
            i = close + marker.length;
            continue;
          }
        }
      }
      plain += ch;
      i += 1;
    }
    flush();
    return nodes;
  }

  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
  const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const BULLET_RE = /^( *)([-*+])[ \t]+(.*)$/;
  const ORDERED_RE = /^( *)(\d{1,9})[.)][ \t]+(.*)$/;
  const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
  const TABLE_ROW_RE = /^ {0,3}\|.*\|[ \t]*$/;
  const TABLE_RULE_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  function tableCells(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function startsBlock(line, next) {
    return (
      FENCE_RE.test(line) ||
      HEADING_RE.test(line) ||
      RULE_RE.test(line) ||
      BULLET_RE.test(line) ||
      ORDERED_RE.test(line) ||
      QUOTE_RE.test(line) ||
      (TABLE_ROW_RE.test(line) && next !== undefined && TABLE_RULE_RE.test(next))
    );
  }

  function parseBlocks(lines, depth, budget) {
    const blocks = [];
    let i = 0;
    while (i < lines.length && budget.blocks > 0) {
      const line = lines[i];
      if (line.trim() === "") {
        i += 1;
        continue;
      }
      budget.blocks -= 1;
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const marker = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length) {
          const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
          if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
            i += 1;
            break;
          }
          body.push(lines[i]);
          i += 1;
        }
        const lang = LANGUAGE_RE.test(fence[2]) ? fence[2] : "";
        blocks.push({ t: "codeblock", lang, v: body.join("\n") });
        continue;
      }
      const heading = HEADING_RE.exec(line);
      if (heading) {
        blocks.push({ t: "h", level: heading[1].length, c: parseInline(heading[2]) });
        i += 1;
        continue;
      }
      if (RULE_RE.test(line)) {
        blocks.push({ t: "hr" });
        i += 1;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          inner.push(QUOTE_RE.exec(lines[i])[1]);
          i += 1;
        }
        blocks.push(
          depth < LIMITS.markdownDepth
            ? { t: "quote", c: parseBlocks(inner, depth + 1, budget) }
            : { t: "p", c: parseInline(inner.join("\n")) },
        );
        continue;
      }
      if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
        const ordered = !BULLET_RE.test(line);
        const items = [];
        let start = 1;
        while (i < lines.length) {
          const match = (ordered ? ORDERED_RE : BULLET_RE).exec(lines[i]);
          if (match) {
            if (items.length === 0 && ordered) start = Math.min(Number(match[2]), 1_000_000_000);
            items.push({ indent: Math.min(Math.floor(match[1].length / 2), 6), text: match[3] });
            i += 1;
            continue;
          }
          // An indented, non-blank line continues the previous item.
          if (items.length > 0 && /^ {2,}\S/.test(lines[i]) && !startsBlock(lines[i].trimStart())) {
            items[items.length - 1].text += `\n${lines[i].trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        blocks.push({
          t: ordered ? "ol" : "ul",
          start,
          items: items.map((item) => ({ indent: item.indent, c: parseInline(item.text) })),
        });
        continue;
      }
      if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_RULE_RE.test(lines[i + 1])) {
        const header = tableCells(line).map((cell) => parseInline(cell));
        const rows = [];
        i += 2;
        while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && rows.length < 500) {
          rows.push(tableCells(lines[i]).map((cell) => parseInline(cell)));
          i += 1;
        }
        blocks.push({ t: "table", header, rows });
        continue;
      }
      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i], lines[i + 1])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: "p", c: parseInline(paragraph.join("\n")) });
    }
    if (i < lines.length) blocks.push({ t: "p", c: [{ t: "text", v: lines.slice(i).join("\n") }] });
    return blocks;
  }

  /**
   * Parses a markdown subset into a tree of plain objects. Text past the size
   * budget is kept as one literal paragraph rather than dropped, so nothing the
   * model said disappears from view.
   */
  function parseMarkdown(source) {
    const text = String(source ?? "").replace(/\r\n?/g, "\n");
    const head = text.slice(0, LIMITS.markdownChars);
    const blocks = parseBlocks(head.split("\n"), 0, { blocks: LIMITS.markdownBlocks });
    if (text.length > head.length) blocks.push({ t: "p", c: [{ t: "text", v: text.slice(head.length) }] });
    return blocks;
  }

  return {
    APPROVAL_MODES,
    DECISIONS,
    LIMITS,
    MODES,
    decodeHostMessage,
    decodeWebviewMessage,
    parseInline,
    parseMarkdown,
    safeUrl,
  };
});
