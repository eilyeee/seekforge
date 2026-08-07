import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/events";
import { t } from "../../lib/i18n";
import { ChatItems } from "./ChatItems";

describe("ChatItems task disclosure", () => {
  it("collapses older tasks and leaves the newest task expanded", () => {
    const items: ChatItem[] = [
      { kind: "user", id: 1, text: "older task" },
      { kind: "assistant", id: 2, text: "older answer", streaming: false },
      {
        kind: "report",
        id: 3,
        report: {
          summary: "older answer",
          changedFiles: [],
          commandsRun: [],
          verification: "none",
          usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
        },
      },
      { kind: "user", id: 4, text: "newest task" },
      { kind: "assistant", id: 5, text: "newest answer", streaming: false },
    ];

    const html = renderToStaticMarkup(createElement(ChatItems, { items }));
    expect(html).toContain("older task");
    expect(html).not.toContain("older answer");
    expect(html).toContain("newest task");
    expect(html).toContain("newest answer");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("uses session metadata for a historical transcript without report events", () => {
    const items: ChatItem[] = [
      { kind: "user", id: 1, text: "historical task" },
      { kind: "assistant", id: 2, text: "historical answer", streaming: false },
    ];

    const html = renderToStaticMarkup(createElement(ChatItems, { items, historicalStatus: "completed" }));
    expect(html).toContain("historical answer");
    // Through t(), not the English literal. The locale is resolved from
    // navigator.language at import time, so asserting "done" passed on an
    // English machine and failed on a Chinese one — a test that reports the
    // developer's system language rather than the component's behavior.
    expect(html).toContain(t("chat.task.completed"));
  });
});
