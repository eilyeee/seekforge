import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import { messagesToItems } from "./messages";

describe("messagesToItems", () => {
  it("replays a transcript into chat items", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "Looking at the file.",
        toolCalls: [{ id: "t1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
      },
      { role: "tool", toolCallId: "t1", content: '{"ok":true,"data":{"content":"…"}}' },
      { role: "assistant", content: "Fixed it." },
    ];
    const items = messagesToItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ kind: "tool", name: "read_file", status: "ok", args: { path: "a.ts" } });
  });

  it("marks tools whose result has ok:false as error", () => {
    const items = messagesToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "run_command", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "t1", content: '{"ok":false,"error":{"code":"denied","message":"no"}}' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", status: "error" });
  });

  it("collapses update_plan calls into a single plan item", () => {
    const plan = (statuses: [string, string]) =>
      JSON.stringify({
        ok: true,
        data: { items: [{ step: "a", status: statuses[0] }, { step: "b", status: statuses[1] }] },
      });
    const items = messagesToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "p1", name: "update_plan", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "p1", content: plan(["in_progress", "pending"]) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "p2", name: "update_plan", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "p2", content: plan(["done", "done"]) },
    ]);
    const plans = items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ items: [{ step: "a", status: "done" }, { step: "b", status: "done" }] });
  });

  it("keeps unparseable tool output as a plain ok result", () => {
    const items = messagesToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "run_command", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "t1", content: "plain text output" },
    ]);
    expect(items[0]).toMatchObject({
      kind: "tool",
      status: "ok",
      result: { ok: true, data: "plain text output" },
    });
  });
});
