// SeekForge chat webview. Runs under a nonce-only CSP with no remote
// resources. Every string shown here came from the model, a tool, or the
// server, so nothing is ever assigned to innerHTML: markdown arrives as a
// parsed tree (chat-shared.js) and is built with createElement/textContent.
(() => {
  const vscode = acquireVsCodeApi();
  const shared = globalThis.SeekForgeChat;
  const LIMITS = shared.LIMITS;

  const MODE_LABELS = { ask: "Ask", edit: "Edit", plan: "Plan" };
  const APPROVAL_LABELS = { confirm: "Confirm each", acceptEdits: "Accept edits", auto: "Auto" };
  const STATUS_GLYPHS = { running: "●", ok: "✓", error: "✕", done: "✓", failed: "✕", cancelled: "⊘" };
  const PLAN_GLYPHS = { pending: "○", in_progress: "◐", done: "●" };

  const byId = (id) => document.getElementById(id);
  const transcript = byId("transcript");
  const empty = byId("empty");
  const composer = byId("composer");
  const sendButton = byId("send");
  const stopButton = byId("stop");
  const modeSelect = byId("mode");
  const approvalSelect = byId("approval");
  const contextToggle = byId("include-context");
  const footer = byId("footer");
  const activity = byId("activity");
  const workspaceLabel = byId("workspace");
  const permissionHost = byId("permission");
  const questionHost = byId("question");
  const mentionMenu = byId("mentions");
  const sessionsPanel = byId("sessions");
  const sessionsList = byId("sessions-list");
  const planBar = byId("plan-bar");

  const items = new Map();
  const dirty = new Set();
  let renderScheduled = false;
  let status = null;
  let countdownTimer;
  let mention = null;
  let mentionTimer;
  let restored = false;
  let localNoticeId = -1;
  /** Disclosures the user opened or closed by hand keep that state across re-renders. */
  const userToggled = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick, title) {
    const node = el("button", className, label);
    node.type = "button";
    if (title) node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  // -------------------------------------------------------------------------
  // Markdown tree -> DOM
  // -------------------------------------------------------------------------

  const INLINE_TAGS = { b: "strong", i: "em", s: "del" };

  function renderInline(nodes, parent) {
    for (const node of nodes) {
      if (node.t === "text") parent.append(document.createTextNode(node.v));
      else if (node.t === "br") parent.append(document.createElement("br"));
      else if (node.t === "code") parent.append(el("code", "inline-code", node.v));
      else if (INLINE_TAGS[node.t]) {
        const child = el(INLINE_TAGS[node.t]);
        renderInline(node.c, child);
        parent.append(child);
      } else if (node.t === "a") {
        const href = shared.safeUrl(node.href);
        if (!href) {
          renderInline(node.c, parent);
          continue;
        }
        const link = el("a");
        link.href = href;
        link.title = href;
        renderInline(node.c, link);
        parent.append(link);
      }
    }
  }

  function codeBlock(text, lang) {
    const wrap = el("div", "code-block");
    const bar = el("div", "code-bar");
    bar.append(el("span", "code-lang", lang || "text"));
    bar.append(
      button("Copy", "link-button", () => {
        navigator.clipboard?.writeText(text).catch(() => {});
      }),
    );
    const pre = el("pre");
    pre.append(el("code", "", text));
    wrap.append(bar, pre);
    return wrap;
  }

  function renderBlocks(blocks, parent) {
    for (const block of blocks) {
      switch (block.t) {
        case "p": {
          const node = el("p");
          renderInline(block.c, node);
          parent.append(node);
          break;
        }
        case "h": {
          const node = el(`h${Math.min(6, Math.max(1, block.level))}`);
          renderInline(block.c, node);
          parent.append(node);
          break;
        }
        case "hr":
          parent.append(el("hr"));
          break;
        case "codeblock":
          parent.append(codeBlock(block.v, block.lang));
          break;
        case "quote": {
          const node = el("blockquote");
          renderBlocks(block.c, node);
          parent.append(node);
          break;
        }
        case "ul":
        case "ol": {
          const list = el(block.t);
          if (block.t === "ol" && block.start !== 1) list.start = block.start;
          for (const item of block.items) {
            const li = el("li");
            if (item.indent > 0) li.style.marginLeft = `${item.indent}em`;
            renderInline(item.c, li);
            list.append(li);
          }
          parent.append(list);
          break;
        }
        case "table": {
          const scroller = el("div", "table-scroll");
          const table = el("table");
          const head = el("thead");
          const headRow = el("tr");
          for (const cell of block.header) {
            const th = el("th");
            renderInline(cell, th);
            headRow.append(th);
          }
          head.append(headRow);
          const body = el("tbody");
          for (const row of block.rows) {
            const tr = el("tr");
            for (const cell of row) {
              const td = el("td");
              renderInline(cell, td);
              tr.append(td);
            }
            body.append(tr);
          }
          table.append(head, body);
          scroller.append(table);
          parent.append(scroller);
          break;
        }
        default:
          break;
      }
    }
  }

  function markdown(text) {
    const root = el("div", "markdown");
    renderBlocks(shared.parseMarkdown(text), root);
    return root;
  }

  // -------------------------------------------------------------------------
  // Transcript items
  // -------------------------------------------------------------------------

  function openFileLink(path) {
    const link = button(path, "link-button file-link", () => post({ type: "openFile", path }), `Open ${path}`);
    return link;
  }

  function usageText(usage) {
    if (!usage) return "";
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const cached = usage.cacheHitTokens ? ` (${k(usage.cacheHitTokens)} cached)` : "";
    return `$${usage.costUsd.toFixed(4)} · ${k(usage.promptTokens)} prompt${cached} · ${k(usage.completionTokens)} completion`;
  }

  function renderItem(item) {
    const node = el("div", `item item-${item.kind}`);
    node.dataset.id = String(item.id);
    node.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("summary")) userToggled.add(item.id);
    });
    switch (item.kind) {
      case "user": {
        node.append(el("div", "user-text", item.text));
        if (item.context?.length) {
          const chips = el("div", "chips");
          for (const label of item.context) chips.append(el("span", "chip", label));
          node.append(chips);
        }
        break;
      }
      case "assistant":
        node.append(markdown(item.text));
        if (item.streaming) node.append(el("span", "cursor", "▍"));
        break;
      case "thinking": {
        const details = el("details", "thinking");
        details.open = item.streaming;
        const summary = el("summary", "", item.streaming ? "Thinking…" : `Thought for ${item.text.length} characters`);
        details.append(summary, el("div", "thinking-text", item.text));
        node.append(details);
        break;
      }
      case "tool": {
        const details = el("details", `tool tool-${item.status}`);
        const summary = el("summary");
        summary.append(el("span", "glyph", STATUS_GLYPHS[item.status] ?? "●"));
        summary.append(el("span", "tool-title", item.title));
        if (item.summary) summary.append(el("span", "tool-summary", item.summary));
        details.append(summary);
        if (item.detail) details.append(el("pre", "tool-detail", item.detail));
        if (item.output) {
          const output = el("pre", "tool-output", item.output);
          details.append(output);
          if (item.status === "running") details.open = true;
        }
        node.append(details);
        break;
      }
      case "file": {
        const row = el("div", "file-row");
        row.append(el("span", "glyph", "±"), openFileLink(item.path));
        node.append(row);
        break;
      }
      case "notice":
        node.classList.add(`notice-${item.level}`);
        node.textContent = item.text;
        break;
      case "subagent": {
        const row = el("div", `subagent subagent-${item.status}`);
        row.append(el("span", "glyph", STATUS_GLYPHS[item.status] ?? "●"));
        row.append(el("span", "subagent-name", item.agentId));
        row.append(el("span", "subagent-task", item.task));
        if (item.detail) row.append(el("div", "subagent-detail", item.detail));
        node.append(row);
        break;
      }
      case "plan": {
        node.append(el("div", "section-title", "Plan"));
        const list = el("ul", "plan-list");
        for (const step of item.steps) {
          const li = el("li", `plan-${step.status}`);
          li.append(el("span", "glyph", PLAN_GLYPHS[step.status]), document.createTextNode(step.step));
          list.append(li);
        }
        node.append(list);
        break;
      }
      case "report": {
        node.append(markdown(item.summary));
        if (item.changedFiles.length) {
          const files = el("div", "report-files");
          files.append(el("div", "section-title", `Changed files (${item.changedFiles.length})`));
          for (const file of item.changedFiles) files.append(openFileLink(file));
          node.append(files);
        }
        if (item.verification) node.append(el("div", "report-verification", `Verification: ${item.verification}`));
        if (item.usage) node.append(el("div", "report-usage", `This run: ${usageText(item.usage)}`));
        break;
      }
      case "failed":
        node.append(el("div", "failed-title", "Run failed"), el("div", "", item.message));
        break;
      default:
        break;
    }
    return node;
  }

  function nearBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  }

  function scheduleRender(id) {
    dirty.add(id);
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(flushRender);
  }

  function flushRender() {
    renderScheduled = false;
    const stick = nearBottom();
    for (const id of dirty) {
      const entry = items.get(id);
      if (!entry) continue;
      const wasOpen = entry.node.querySelector("details")?.open;
      const next = renderItem(entry.data);
      const details = next.querySelector("details");
      if (details && wasOpen !== undefined && userToggled.has(id)) details.open = wasOpen;
      entry.node.replaceWith(next);
      entry.node = next;
    }
    dirty.clear();
    empty.hidden = items.size > 0;
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  }

  function upsert(item) {
    const existing = items.get(item.id);
    if (existing) {
      existing.data = item;
      scheduleRender(item.id);
      return;
    }
    const node = renderItem(item);
    const stick = nearBottom();
    transcript.append(node);
    items.set(item.id, { data: item, node });
    empty.hidden = true;
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  }

  function append(id, text) {
    const entry = items.get(id);
    if (!entry || typeof entry.data.text !== "string") return;
    entry.data.text = (entry.data.text + text).slice(0, LIMITS.itemText);
    scheduleRender(id);
  }

  function resetTranscript(list) {
    items.clear();
    dirty.clear();
    userToggled.clear();
    for (const node of [...transcript.querySelectorAll(".item")]) node.remove();
    for (const item of list) upsert(item);
    empty.hidden = items.size > 0;
    transcript.scrollTop = transcript.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Status, prompts
  // -------------------------------------------------------------------------

  function applyStatus(next) {
    status = next;
    sendButton.hidden = next.running;
    stopButton.hidden = !next.running;
    const parts = [];
    if (next.usage) parts.push(usageText(next.usage));
    if (next.contextPercent !== null) parts.push(`context ${Math.round(next.contextPercent)}%`);
    footer.textContent = parts.join(" · ") || "No usage yet";
    activity.textContent = next.running ? next.activity || "Working…" : "";
    activity.hidden = !next.running;
    workspaceLabel.textContent = next.workspace
      ? `${next.workspace}${next.sessionId ? ` · ${next.sessionId.slice(0, 12)}` : ""}`
      : "New conversation";
    planBar.hidden = !(next.planReady && !next.running);
  }

  function countdown(node, expiresAt) {
    clearInterval(countdownTimer);
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      node.textContent = `The server denies this in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} if unanswered.`;
      if (left === 0) clearInterval(countdownTimer);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function rawBlock(label, text) {
    const wrap = el("div", "raw");
    wrap.append(el("div", "raw-label", label), el("pre", "raw-value", text));
    return wrap;
  }

  function renderPermission(view) {
    permissionHost.replaceChildren();
    clearInterval(countdownTimer);
    permissionHost.hidden = !view;
    if (!view) return;
    const card = el("div", "card permission-card");
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-label", "Permission request");
    card.append(
      el("div", "card-title", `Permission needed · ${view.toolName}${view.permission ? ` (${view.permission})` : ""}`),
    );
    card.append(el("div", "card-description", view.description));
    if (view.escalation) {
      card.append(el("div", "warning", "This retries the command WITHOUT the sandbox you configured."));
    }
    if (view.command !== undefined) card.append(rawBlock("Raw command", view.command));
    if (view.path !== undefined) card.append(rawBlock("Raw path", view.path));
    if (view.plan !== undefined) {
      const plan = el("div", "plan-preview");
      plan.append(markdown(view.plan));
      card.append(plan);
    }
    if (view.hasDiff) {
      const row = el("div", "diff-row");
      row.append(el("span", "diff-stats", `+${view.added} −${view.removed}`));
      row.append(
        button(
          "Open diff",
          "secondary",
          () => post({ type: "openReviewDiff", requestId: view.requestId }),
          "Review in the diff editor",
        ),
      );
      card.append(row);
    }
    const checks = [];
    if (view.hunks.length) {
      const list = el("fieldset", "hunks");
      list.append(el("legend", "", "Edits to apply"));
      for (const hunk of view.hunks) {
        const label = el("label", "hunk");
        const box = el("input");
        box.type = "checkbox";
        box.checked = true;
        box.value = String(hunk.index);
        checks.push(box);
        label.append(box, el("span", "hunk-label", `#${hunk.index + 1} ${hunk.preview}`));
        list.append(label);
      }
      card.append(list);
    }
    if (view.rule !== undefined)
      card.append(rawBlock("“Always allow” writes this rule to your user config", view.rule));

    const answer = (decision, extra = {}) =>
      post({ type: "permission", requestId: view.requestId, decision, ...extra });
    const actions = el("div", "actions");
    actions.append(button("Allow once", "primary", () => answer("once")));
    if (view.hunks.length) {
      actions.append(
        button("Allow selected edits", "secondary", () => {
          const selectedHunks = checks.filter((box) => box.checked).map((box) => Number(box.value));
          if (selectedHunks.length === 0) return;
          answer("hunks", { selectedHunks });
        }),
      );
    }
    if (view.allowSession) actions.append(button("Allow for session", "secondary", () => answer("session")));
    if (view.allowAlways) actions.append(button("Always allow", "secondary", () => answer("always")));
    actions.append(button("Deny", "danger", () => answer("deny")));
    card.append(actions);

    const feedback = el("div", "feedback");
    const reason = el("textarea", "feedback-input");
    reason.rows = 2;
    reason.maxLength = LIMITS.feedbackChars;
    reason.placeholder = "Deny with a reason: tell SeekForge what to do instead…";
    reason.setAttribute("aria-label", "Reason for denying");
    feedback.append(
      reason,
      button("Deny with reason", "secondary", () => {
        const text = reason.value.trim();
        answer("deny", text ? { feedback: text } : {});
      }),
    );
    card.append(feedback);
    const timer = el("div", "countdown");
    card.append(timer);
    countdown(timer, view.expiresAt);
    permissionHost.append(card);
    if (nearBottom()) transcript.scrollTop = transcript.scrollHeight;
  }

  function renderQuestion(view) {
    questionHost.replaceChildren();
    questionHost.hidden = !view;
    if (!view) return;
    const card = el("div", "card question-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Question from SeekForge");
    card.append(el("div", "card-title", "SeekForge asks"));
    card.append(markdown(view.question));
    const answer = (text) => post({ type: "question", id: view.id, answer: text });
    const options = el("div", "actions");
    for (const option of view.options) options.append(button(option, "secondary option", () => answer(option)));
    card.append(options);
    if (view.freeText) {
      const row = el("div", "feedback");
      const input = el("textarea", "feedback-input");
      input.rows = 2;
      input.maxLength = LIMITS.answerChars;
      input.placeholder = "Or type your own answer…";
      input.setAttribute("aria-label", "Your answer");
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && input.value.trim()) {
          event.preventDefault();
          answer(input.value.trim());
        }
      });
      row.append(
        input,
        button("Answer", "primary", () => input.value.trim() && answer(input.value.trim())),
      );
      card.append(row);
    }
    card.append(button("Decline to answer", "link-button", () => answer("")));
    questionHost.append(card);
  }

  function renderSessions(list) {
    sessionsList.replaceChildren();
    if (list.length === 0) sessionsList.append(el("div", "muted", "No stored sessions for this workspace."));
    for (const session of list) {
      const row = button("", "session-row", () => {
        sessionsPanel.hidden = true;
        post({ type: "resumeSession", sessionId: session.id });
      });
      row.append(el("span", "session-title", session.title));
      row.append(el("span", "session-meta", `${session.status} · ${session.updatedAt.replace("T", " ").slice(0, 16)}`));
      sessionsList.append(row);
    }
    sessionsPanel.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  function options() {
    return { mode: modeSelect.value, approvalMode: approvalSelect.value, includeContext: contextToggle.checked };
  }

  function saveDraft() {
    vscode.setState({ draft: composer.value.slice(0, LIMITS.promptChars), ...options() });
  }

  function applyOptions(next) {
    modeSelect.value = next.mode;
    approvalSelect.value = next.approvalMode;
    contextToggle.checked = next.includeContext;
  }

  function send() {
    const text = composer.value;
    if (!text.trim() || status?.running) return;
    post({ type: "send", text: text.slice(0, LIMITS.promptChars), ...options() });
    composer.value = "";
    closeMentions();
    saveDraft();
    autosize();
  }

  function insertText(text) {
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? start;
    composer.value = `${composer.value.slice(0, start)}${text}${composer.value.slice(end)}`.slice(
      0,
      LIMITS.promptChars,
    );
    const caret = Math.min(start + text.length, composer.value.length);
    composer.setSelectionRange(caret, caret);
    composer.focus();
    saveDraft();
    autosize();
  }

  function autosize() {
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 240)}px`;
  }

  /** The `@query` token that ends at the caret, if any. */
  function mentionAtCaret() {
    const caret = composer.selectionStart ?? 0;
    const before = composer.value.slice(0, caret);
    const match = /(^|\s)@([^\s@]{0,200})$/.exec(before);
    return match ? { start: caret - match[2].length - 1, end: caret, query: match[2] } : null;
  }

  function closeMentions() {
    mention = null;
    mentionMenu.hidden = true;
    mentionMenu.replaceChildren();
    composer.setAttribute("aria-expanded", "false");
  }

  function updateMentions() {
    const token = mentionAtCaret();
    if (!token) {
      closeMentions();
      return;
    }
    mention = { ...token, files: mention?.files ?? [], active: 0 };
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => post({ type: "searchFiles", query: token.query }), 120);
  }

  function chooseMention(file) {
    if (!mention) return;
    const before = composer.value.slice(0, mention.start);
    const after = composer.value.slice(mention.end);
    composer.value = `${before}@${file} ${after}`;
    const caret = before.length + file.length + 2;
    composer.setSelectionRange(caret, caret);
    closeMentions();
    composer.focus();
    saveDraft();
  }

  function renderMentions(query, files) {
    if (!mention || mention.query !== query) return;
    mention.files = files;
    mention.active = 0;
    mentionMenu.replaceChildren();
    if (files.length === 0) {
      closeMentions();
      return;
    }
    for (const [index, file] of files.entries()) {
      const option = button(file, index === 0 ? "mention active" : "mention", () => chooseMention(file));
      option.setAttribute("role", "option");
      option.tabIndex = -1;
      mentionMenu.append(option);
    }
    mentionMenu.hidden = false;
    composer.setAttribute("aria-expanded", "true");
  }

  function moveMention(delta) {
    if (!mention?.files.length) return;
    mention.active = (mention.active + delta + mention.files.length) % mention.files.length;
    for (const [index, child] of [...mentionMenu.children].entries()) {
      child.classList.toggle("active", index === mention.active);
      if (index === mention.active) child.scrollIntoView({ block: "nearest" });
    }
  }

  composer.addEventListener("keydown", (event) => {
    if (!mentionMenu.hidden && mention?.files.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveMention(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseMention(mention.files[mention.active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentions();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  composer.addEventListener("input", () => {
    autosize();
    saveDraft();
    updateMentions();
  });
  composer.addEventListener("blur", () => setTimeout(closeMentions, 150));

  sendButton.addEventListener("click", send);
  stopButton.addEventListener("click", () => post({ type: "stop" }));
  for (const control of [modeSelect, approvalSelect, contextToggle]) {
    control.addEventListener("change", () => {
      post({ type: "setOptions", ...options() });
      saveDraft();
    });
  }
  byId("add-selection").addEventListener("click", () => post({ type: "addSelection" }));
  byId("new-session").addEventListener("click", () => post({ type: "newSession" }));
  byId("open-editor").addEventListener("click", () => post({ type: "openInEditor" }));
  byId("show-sessions").addEventListener("click", () => {
    if (!sessionsPanel.hidden) {
      sessionsPanel.hidden = true;
      return;
    }
    sessionsList.replaceChildren(el("div", "muted", "Loading sessions…"));
    sessionsPanel.hidden = false;
    post({ type: "listSessions" });
  });
  byId("close-sessions").addEventListener("click", () => {
    sessionsPanel.hidden = true;
  });
  byId("execute-plan").addEventListener("click", () => post({ type: "executePlan" }));

  for (const [select, labels] of [
    [modeSelect, MODE_LABELS],
    [approvalSelect, APPROVAL_LABELS],
  ]) {
    for (const [value, label] of Object.entries(labels)) {
      const option = el("option", "", label);
      option.value = value;
      select.append(option);
    }
  }

  // -------------------------------------------------------------------------
  // Host messages
  // -------------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    const decoded = shared.decodeHostMessage(event.data);
    if (!decoded.ok) return;
    const message = decoded.message;
    switch (message.type) {
      case "reset":
        resetTranscript(message.items);
        applyStatus(message.status);
        renderPermission(message.permission);
        renderQuestion(message.question);
        if (!restored) applyOptions(message.options);
        restored = true;
        break;
      case "upsert":
        upsert(message.item);
        break;
      case "append":
        append(message.id, message.text);
        break;
      case "status":
        applyStatus(message.status);
        break;
      case "permission":
        renderPermission(message.pending);
        break;
      case "question":
        renderQuestion(message.pending);
        break;
      case "sessions":
        renderSessions(message.sessions);
        break;
      case "files":
        renderMentions(message.query, message.files);
        break;
      case "insertText":
        insertText(message.text);
        break;
      case "notice":
        upsert({ id: localNoticeId--, kind: "notice", level: message.level, text: message.message });
        break;
      case "focus":
        composer.focus();
        break;
      default:
        break;
    }
  });

  // A view that was hidden and re-created restores its own draft and toggles.
  const saved = vscode.getState();
  if (saved && typeof saved.draft === "string") {
    composer.value = saved.draft.slice(0, LIMITS.promptChars);
    const candidate = { mode: saved.mode, approvalMode: saved.approvalMode, includeContext: saved.includeContext };
    if (shared.MODES.includes(candidate.mode) && shared.APPROVAL_MODES.includes(candidate.approvalMode)) {
      applyOptions({ ...candidate, includeContext: candidate.includeContext !== false });
      restored = true;
      post({ type: "setOptions", ...options() });
    }
  }
  autosize();
  post({ type: "ready" });
  composer.focus();
})();
