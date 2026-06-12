import { describe, expect, it } from "vitest";
import { filterSessions } from "./sessions-filter";

const sessions = [
  { id: "s-20260610-a1b2", task: "Add a --json flag to the run command" },
  { id: "s-20260609-c3d4", task: "为 REPL 增加 /help 命令" },
  { id: "s-20260608-e5f6", task: "Explain how the permission system works" },
];

describe("filterSessions", () => {
  it("returns everything for a blank query", () => {
    expect(filterSessions(sessions, "")).toEqual(sessions);
    expect(filterSessions(sessions, "   ")).toEqual(sessions);
  });

  it("matches the id (case-insensitive)", () => {
    expect(filterSessions(sessions, "A1B2").map((s) => s.id)).toEqual(["s-20260610-a1b2"]);
  });

  it("matches the task text, including CJK", () => {
    expect(filterSessions(sessions, "PERMISSION").map((s) => s.id)).toEqual(["s-20260608-e5f6"]);
    expect(filterSessions(sessions, "命令").map((s) => s.id)).toEqual(["s-20260609-c3d4"]);
  });

  it("requires every term to match (id OR task each)", () => {
    expect(filterSessions(sessions, "json run").map((s) => s.id)).toEqual(["s-20260610-a1b2"]);
    expect(filterSessions(sessions, "json permission")).toEqual([]);
  });

  it("matches nothing when no session fits", () => {
    expect(filterSessions(sessions, "zzz")).toEqual([]);
  });
});
