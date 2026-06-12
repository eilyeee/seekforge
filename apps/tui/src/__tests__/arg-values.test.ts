import { describe, expect, it } from "vitest";
import { argCandidates, type ArgContext } from "../arg-values.js";

const ctx: ArgContext = {
  sessions: [
    { id: "s-1", title: "fix the parser", status: "active" },
    { id: "s-2", title: "a".repeat(50), status: "done" },
  ],
  todos: [
    { index: 1, text: "ship it", done: false },
    { index: 2, text: "write docs", done: true },
    { index: 3, text: "t".repeat(60), done: false },
  ],
  bgTasks: [
    { id: "bg-1", command: "pnpm dev", status: "running" },
    { id: "bg-2", command: "x".repeat(60), status: "running" },
    { id: "bg-3", command: "pnpm build", status: "exited" },
  ],
  models: [
    { id: "deepseek-v4-pro", note: "V4 flagship" },
    { id: "deepseek-v4-flash", note: "V4 fast" },
  ],
  memoryFactCount: 7,
};

describe("argCandidates", () => {
  it("resume lists sessions with [status] title hints, title capped at 40", () => {
    const got = argCandidates("resume", "", ctx);
    expect(got).toEqual([
      { value: "s-1", hint: "[active] fix the parser" },
      { value: "s-2", hint: `[done] ${"a".repeat(39)}…` },
    ]);
  });

  it("approve offers the three modes", () => {
    const got = argCandidates("approve", "", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["auto", "confirm", "plan"]);
    expect(got.every((c) => typeof c.hint === "string" && c.hint.length > 0)).toBe(true);
  });

  it("think offers on/off/high/max", () => {
    const got = argCandidates("think", "", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["on", "off", "high", "max"]);
  });

  it("model lists ctx.models with notes as hints", () => {
    expect(argCandidates("model", "", ctx)).toEqual([
      { value: "deepseek-v4-pro", hint: "V4 flagship" },
      { value: "deepseek-v4-flash", hint: "V4 fast" },
    ]);
  });

  it("rewind offers a dry-run empty value and yes", () => {
    expect(argCandidates("rewind", "", ctx)).toEqual([
      { value: "", hint: "dry-run preview" },
      { value: "yes", hint: "apply" },
    ]);
  });

  it("memory interpolates the fact count and offers edit", () => {
    expect(argCandidates("memory", "", ctx)).toEqual([
      { value: "", hint: "list 7 facts" },
      { value: "edit", hint: "open in $EDITOR" },
    ]);
  });

  it("config offers empty/edit", () => {
    const got = argCandidates("config", "", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["", "edit"]);
  });

  it("todo with no arg offers the verbs", () => {
    const got = argCandidates("todo", "", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["add", "done", "rm"]);
  });

  it("todo with a verb prefix still offers the verbs", () => {
    const got = argCandidates("todo", "do", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["add", "done", "rm"]);
  });

  it("todo 'done ' stage lists only undone items as full arg values", () => {
    const got = argCandidates("todo", "done ", ctx);
    expect(got).toEqual([
      { value: "done 1", hint: "☐ ship it" },
      { value: "done 3", hint: `☐ ${"t".repeat(39)}…` },
    ]);
  });

  it("todo 'rm ' stage lists all items with their checkbox state", () => {
    const got = argCandidates("todo", "rm ", ctx) ?? [];
    expect(got.map((c) => c.value)).toEqual(["rm 1", "rm 2", "rm 3"]);
    expect(got[1]?.hint).toBe("☑ write docs");
  });

  it("tasks with no arg offers list/kill", () => {
    expect(argCandidates("tasks", "", ctx)).toEqual([
      { value: "", hint: "list" },
      { value: "kill", hint: "stop one" },
    ]);
  });

  it("tasks kill stage lists only running tasks, command capped at 40", () => {
    const got = argCandidates("tasks", "kill ", ctx);
    expect(got).toEqual([
      { value: "kill bg-1", hint: "pnpm dev" },
      { value: "kill bg-2", hint: `${"x".repeat(39)}…` },
    ]);
  });

  it("export offers the single default-path candidate", () => {
    expect(argCandidates("export", "", ctx)).toEqual([{ value: "", hint: "default path" }]);
  });

  it("returns null for commands without a completable argument", () => {
    for (const name of ["fork", "diff", "help", "plan", "remember", "nonsense"]) {
      expect(argCandidates(name, "", ctx)).toBeNull();
    }
  });
});
