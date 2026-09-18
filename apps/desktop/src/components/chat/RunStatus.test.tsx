import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/events";
import { t } from "../../lib/i18n";
import { liveRunActivity, RunStatus } from "./RunStatus";

describe("liveRunActivity", () => {
  it("prefers the latest running tool over older activity", () => {
    const items: ChatItem[] = [
      { kind: "thinking", id: 1, text: "thinking", streaming: true },
      { kind: "tool", id: 2, name: "run_command", args: {}, status: "running" },
    ];
    expect(liveRunActivity(items)).toEqual({ kind: "tool", name: "run_command" });
  });

  it("renders an activity summary and completed-action count", () => {
    const items: ChatItem[] = [
      { kind: "tool", id: 1, name: "read_file", args: {}, status: "ok" },
      { kind: "tool", id: 2, name: "apply_patch", args: {}, status: "running" },
    ];
    const html = renderToStaticMarkup(createElement(RunStatus, { items }));
    expect(html).toContain(t("chat.runStatus.tool", { tool: "apply_patch" }));
    expect(html).toContain(t("chat.runStatus.actions", { count: 1 }));
  });
});
