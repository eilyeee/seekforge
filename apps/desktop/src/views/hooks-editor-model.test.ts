import { describe, expect, it } from "vitest";
import { HOOK_STAGES } from "../types";
import { emptyHookEntry, fromHooksDraft, toHooksDraft, type StoredHooks } from "./hooks-editor-model";

describe("hooks editor model", () => {
  it("round-trips fields and stages it does not know", () => {
    const stored: StoredHooks = {
      preToolUse: [{ command: "echo hi", match: "run_command" }],
      postToolUse: [{ type: "http", url: "http://127.0.0.1:9/h", timeout: 5, headers: { a: "b" } }],
      laterStage: [{ command: "echo later", pattern: "src/" }],
    };
    const draft = toHooksDraft(stored);
    expect(draft.stages.slice(0, HOOK_STAGES.length)).toEqual([...HOOK_STAGES]);
    expect(draft.stages.at(-1)).toBe("laterStage");
    expect(draft.entries.postToolUse?.[0]?.extra).toEqual([
      { key: "type", json: '"http"' },
      { key: "url", json: '"http://127.0.0.1:9/h"' },
      { key: "timeout", json: "5" },
      { key: "headers", json: '{"a":"b"}' },
    ]);
    expect(fromHooksDraft(draft)).toEqual({ ok: true, hooks: stored });
  });

  it("drops blank new entries, trims known fields, and refuses bad extra JSON", () => {
    const draft = toHooksDraft({});
    draft.entries.stop = [
      emptyHookEntry(),
      { ...emptyHookEntry(), command: "  make lint ", match: " " },
      { ...emptyHookEntry(), extra: [{ key: "type", json: '"prompt"' }] },
    ];
    expect(fromHooksDraft(draft)).toEqual({
      ok: true,
      hooks: { stop: [{ command: "make lint" }, { type: "prompt" }] },
    });

    draft.entries.stop = [{ ...emptyHookEntry(), command: "x", extra: [{ key: "timeout", json: "five" }] }];
    expect(fromHooksDraft(draft)).toMatchObject({ ok: false, stage: "stop" });
    draft.entries.stop = [{ ...emptyHookEntry(), command: "x", extra: [{ key: "command", json: '"y"' }] }];
    expect(fromHooksDraft(draft)).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
  });

  it("keeps a known field whose stored value is not a string as an extra", () => {
    const draft = toHooksDraft({ stop: [{ command: "x", match: 3 }] });
    expect(draft.entries.stop?.[0]).toMatchObject({ command: "x", match: "", extra: [{ key: "match", json: "3" }] });
    expect(fromHooksDraft(draft)).toEqual({ ok: true, hooks: { stop: [{ command: "x", match: 3 }] } });
  });
});
