import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTrace, renameSession, sessionTitle, writeSessionMeta } from "@seekforge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterSessions,
  initialSessionPicker,
  loadSessionRows,
  MAX_SESSION_NAME_CHARS,
  readSessionPreview,
  selectedSession,
  sessionLine,
  sessionPickerKey,
  withRenamedRow,
  type SessionPickerState,
  type SessionRow,
} from "../session-picker.js";

const rows: SessionRow[] = [
  {
    id: "s1",
    title: "Fix login bug",
    named: true,
    task: "fix the login",
    status: "completed",
    updatedAt: "2026-01-01T00:00:00Z",
    costUsd: 0.5,
  },
  {
    id: "s2",
    title: "Add caching",
    named: false,
    task: "add a redis cache",
    status: "failed",
    updatedAt: "2026-01-02T00:00:00Z",
  },
  {
    id: "abc3",
    title: "Refactor",
    named: false,
    task: "refactor the login form",
    status: "idle",
    updatedAt: "2026-01-03T00:00:00Z",
  },
];

function type(state: SessionPickerState, text: string): SessionPickerState {
  let next = state;
  for (const ch of text) {
    const outcome = sessionPickerKey(next, ch, { input: ch });
    if (outcome.kind !== "update") throw new Error(`unexpected ${outcome.kind} for ${ch}`);
    next = outcome.state;
  }
  return next;
}

function key(state: SessionPickerState, name: NonNullable<Parameters<typeof sessionPickerKey>[2]["name"]>) {
  return sessionPickerKey(state, "", { input: "", name });
}

describe("filterSessions", () => {
  it("matches every word against id, title and task, case-insensitively", () => {
    expect(filterSessions(rows, "LOGIN").map((r) => r.id)).toEqual(["s1", "abc3"]);
    expect(filterSessions(rows, "login form").map((r) => r.id)).toEqual(["abc3"]);
    expect(filterSessions(rows, "abc").map((r) => r.id)).toEqual(["abc3"]);
    expect(filterSessions(rows, "  ")).toHaveLength(3);
  });
});

describe("sessionPickerKey", () => {
  it("searches after '/', keeps the filter, and resumes the filtered selection", () => {
    let state = initialSessionPicker(rows);
    const open = sessionPickerKey(state, "/", { input: "/" });
    expect(open.kind).toBe("update");
    state = type((open as { state: SessionPickerState }).state, "cach");
    expect(state.query).toBe("cach");
    expect(selectedSession(state)?.id).toBe("s2");
    // f and r are text while searching.
    state = type(state, "f");
    expect(state.query).toBe("cachf");
    state = (key(state, "backspace") as { state: SessionPickerState }).state;
    state = (key(state, "return") as { state: SessionPickerState }).state;
    expect(state.searching).toBe(false);
    expect(state.query).toBe("cach");
    expect(key(state, "return")).toEqual({ kind: "resume", id: "s2" });
  });

  it("forks and renames the selection with f and r", () => {
    const state = initialSessionPicker(rows);
    const down = (key(state, "down") as { state: SessionPickerState }).state;
    expect(sessionPickerKey(down, "f", { input: "f" })).toEqual({ kind: "fork", id: "s2" });
    const renaming = sessionPickerKey(state, "r", { input: "r" });
    expect(renaming).toEqual({ kind: "update", state: { ...state, renaming: { id: "s1", text: "Fix login bug" } } });
    let editing = (renaming as { state: SessionPickerState }).state;
    for (let i = 0; i < 3; i += 1) editing = (key(editing, "backspace") as { state: SessionPickerState }).state;
    editing = type(editing, "OUT");
    expect(key(editing, "return")).toEqual({
      kind: "rename",
      id: "s1",
      title: "Fix login OUT",
      state,
    });
    expect(key(editing, "escape")).toEqual({ kind: "update", state });
    // An unnamed session starts from an empty name.
    expect(sessionPickerKey(down, "r", { input: "r" })).toMatchObject({
      state: { renaming: { id: "s2", text: "" } },
    });
  });

  it("caps the rename input and ignores control keys in it", () => {
    let state: SessionPickerState = { ...initialSessionPicker(rows), renaming: { id: "s1", text: "" } };
    state = type(state, "x".repeat(MAX_SESSION_NAME_CHARS + 5));
    expect(state.renaming?.text).toHaveLength(MAX_SESSION_NAME_CHARS);
    expect(sessionPickerKey(state, "a", { input: "a", ctrl: true })).toEqual({ kind: "ignore" });
  });

  it("clears the filter on the first Esc and closes on the second", () => {
    const filtered: SessionPickerState = { ...initialSessionPicker(rows), query: "login" };
    const cleared = key(filtered, "escape");
    expect(cleared).toEqual({ kind: "update", state: { ...filtered, query: "" } });
    expect(key((cleared as { state: SessionPickerState }).state, "escape")).toEqual({ kind: "close" });
  });

  it("wraps navigation within the filtered rows", () => {
    const state: SessionPickerState = { ...initialSessionPicker(rows), query: "login" };
    const up = key(state, "up") as { state: SessionPickerState };
    expect(selectedSession(up.state)?.id).toBe("abc3");
    expect(key({ ...state, query: "zzz" }, "return")).toEqual({ kind: "ignore" });
  });

  it("updates a renamed row in place", () => {
    const state = withRenamedRow(initialSessionPicker(rows), "s2", "Cache work", true);
    expect(state.rows[1]).toMatchObject({ title: "Cache work", named: true });
    expect(sessionLine(state.rows[1]!, Date.parse("2026-01-02T01:00:00Z"))).toMatch(
      /^★ Cache work {2}\[failed\] {2}1h ago {2}— {2}s2$/,
    );
  });
});

describe("session rows and preview (core-backed)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "sf-sessions-")));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("reads names, the first prompt and the last reply", () => {
    const now = new Date().toISOString();
    const meta = {
      id: "20260101T000000-abc",
      task: "fix the flaky test",
      mode: "edit" as const,
      status: "completed" as const,
      createdAt: now,
      updatedAt: now,
    };
    writeSessionMeta(workspace, meta);
    const trace = createSessionTrace(workspace, meta.id);
    trace.message({ role: "user", content: "fix the flaky test" });
    trace.message({ role: "assistant", content: "Looking." });
    trace.message({ role: "tool", content: "{}", toolCallId: "c1" });
    trace.message({ role: "assistant", content: "Fixed it by pinning the seed." });
    renameSession(workspace, meta.id, "Flaky test");
    const [row] = loadSessionRows(workspace);
    expect(row).toMatchObject({ id: meta.id, title: "Flaky test", named: true, task: "fix the flaky test" });
    expect(readSessionPreview(workspace, meta.id)).toEqual({
      firstPrompt: "fix the flaky test",
      lastReply: "Fixed it by pinning the seed.",
      messages: 4,
    });
    expect(sessionTitle(workspace, meta.id)).toBe("Flaky test");
    expect(readSessionPreview(workspace, "20990101T000000-missing")).toEqual({ messages: 0 });
  });
});
