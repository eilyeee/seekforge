import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import { QueuedMessages } from "../components/chat/QueuedMessages";
import { TabBar } from "../components/chat/TabBar";
import { urlsFromChat } from "../components/dock/BottomDock";
import { isWorkbenchUrl, PreviewPanel } from "../components/dock/PreviewPanel";
import { spanStyle } from "../components/dock/TerminalPanel";
import { initialTabsState } from "../lib/tabs";
import type { GitRemoteInfo } from "../types";
import { AgentEditorDialog } from "./AgentEditorDialog";
import { emptyAgentForm } from "./agent-editor-model";
import { defaultRemote, GitRemoteBar, PrDialog, PushDialog, pushTarget } from "./GitRemoteActions";
import { RuleEditorDialog } from "./PermissionRulesSection";

setLocale("en");

const info: GitRemoteInfo = {
  branch: "feature/x",
  remotes: ["fork", "origin"],
  upstream: { remote: "origin", branch: "feature-x" },
  ahead: 2,
  behind: 0,
  gh: { available: false },
};

describe("push and PR surfaces", () => {
  it("shows where a push lands and never offers force", () => {
    expect(defaultRemote(info)).toBe("origin");
    expect(defaultRemote({ ...info, upstream: null })).toBe("origin");
    expect(defaultRemote({ ...info, upstream: null, remotes: ["fork"] })).toBe("fork");
    expect(pushTarget(info, "origin")).toEqual({ remote: "origin", branch: "feature/x", destination: "feature-x" });
    expect(pushTarget(info, "fork")).toEqual({ remote: "fork", branch: "feature/x", destination: "feature/x" });
    expect(pushTarget({ ...info, branch: null }, "origin")).toBeNull();
    expect(pushTarget(info, "elsewhere")).toBeNull();

    const html = renderToStaticMarkup(createElement(PushDialog, { info, onConfirm: () => {}, onCancel: () => {} }));
    expect(html).toContain("git push origin feature/x:feature-x");
    expect(html).toContain("never force-pushes");
    expect(html).not.toContain("--force");
  });

  it("explains a missing gh and disables Create PR", () => {
    const html = renderToStaticMarkup(
      createElement(GitRemoteBar, { info, busy: false, onPush: () => {}, onCreatePr: () => {} }),
    );
    expect(html).toContain("GitHub CLI (gh)");
    expect(html).toContain("↑2");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create PR/);
    const pr = renderToStaticMarkup(
      createElement(PrDialog, {
        branch: "feature/x",
        busy: false,
        error: "boom",
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    expect(pr).toContain("Pull request from feature/x");
    expect(pr).toContain("Open as draft");
    expect(pr).toContain("boom");
  });
});

describe("permission rule editor", () => {
  it("explains why project scope only tightens", () => {
    const html = renderToStaticMarkup(
      createElement(RuleEditorDialog, {
        editor: { scope: "project", form: { action: "deny", tool: "run_command", match: "rm" } },
        busy: false,
        onChange: () => {},
        onSave: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("may only tighten");
    expect(html).toContain("deny — always block");
  });
});

describe("agent editor dialog", () => {
  it("lists frontmatter fields the form does not own", () => {
    const html = renderToStaticMarkup(
      createElement(AgentEditorDialog, {
        intent: "edit",
        initial: { ...emptyAgentForm("global"), id: "keeper", extra: [{ key: "color", value: "blue" }] },
        path: "/home/u/.seekforge/agents/keeper/AGENT.md",
        onSave: async () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("Edit subagent keeper");
    expect(html).toContain('value="color"');
    expect(html).toContain("blue");
    expect(html).toContain("/home/u/.seekforge/agents/keeper/AGENT.md");
  });
});

describe("chat queue and tab names", () => {
  it("renders queued messages with edit and remove", () => {
    const html = renderToStaticMarkup(
      createElement(QueuedMessages, {
        queue: [
          { id: 1, text: "then run the tests" },
          { id: 2, text: "and lint" },
        ],
        onEdit: () => {},
        onRemove: () => {},
      }),
    );
    expect(html).toContain("Queued (2)");
    expect(html).toContain("then run the tests");
    expect(html).toContain("Remove from queue");
    expect(
      renderToStaticMarkup(createElement(QueuedMessages, { queue: [], onEdit: () => {}, onRemove: () => {} })),
    ).toBe("");
  });

  it("offers double-click rename only when a handler is wired", () => {
    const tabs = initialTabsState().tabs;
    const props = {
      tabs,
      activeTabId: "t1",
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onNewWorktree: () => {},
      onMergeWorktree: () => {},
      onDiscardWorktree: () => {},
    };
    expect(renderToStaticMarkup(createElement(TabBar, { ...props, onRename: () => {} }))).toContain(
      "double-click to rename",
    );
    expect(renderToStaticMarkup(createElement(TabBar, props))).not.toContain("double-click to rename");
  });
});

describe("dock helpers", () => {
  it("never frames the workbench itself", () => {
    const here = { hostname: "127.0.0.1", port: "7373" };
    expect(isWorkbenchUrl("http://localhost:7373/", here)).toBe(true);
    expect(isWorkbenchUrl("http://127.0.0.1:7373/x", here)).toBe(true);
    expect(isWorkbenchUrl("http://127.0.0.1:5173/", here)).toBe(false);
    expect(isWorkbenchUrl("http://127.0.0.1:5173/", undefined)).toBe(false);
  });

  it("renders an empty preview with guidance and detected suggestions", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewPanel, { url: "", onUrl: () => {}, suggestions: ["http://localhost:5173/"] }),
    );
    expect(html).toContain("Only 127.0.0.1, localhost and [::1]");
    expect(html).toContain("http://localhost:5173/");
    expect(html).not.toContain("<iframe");
    const framed = renderToStaticMarkup(
      createElement(PreviewPanel, { url: "http://localhost:5173/", onUrl: () => {}, suggestions: [] }),
    );
    expect(framed).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"',
    );
    expect(framed).not.toContain("allow-top-navigation");
  });

  it("collects preview URLs from command output in the transcript", () => {
    expect(
      urlsFromChat([
        { kind: "user", id: 1, text: "http://localhost:1111 is not command output" },
        {
          kind: "tool",
          id: 2,
          name: "run_command",
          args: {},
          status: "running",
          tail: "VITE ready\n  Local: http://localhost:5173/",
        },
        {
          kind: "tool",
          id: 3,
          name: "run_command",
          args: {},
          status: "ok",
          result: { ok: true, data: { stdout: "listening on http://127.0.0.1:8080\n" } },
        },
      ]),
    ).toEqual(["http://localhost:5173/", "http://127.0.0.1:8080/"]);
  });

  it("styles terminal spans with themed ANSI colors", () => {
    expect(spanStyle({})).toBeUndefined();
    expect(spanStyle({ fg: "ansi:1", bold: true })).toEqual({ color: "rgb(var(--sf-ansi-1))", fontWeight: 600 });
    expect(spanStyle({ fg: "rgb(1,2,3)", inverse: true })).toEqual({
      color: "rgb(var(--sf-terminal-bg))",
      backgroundColor: "rgb(1,2,3)",
    });
  });
});
