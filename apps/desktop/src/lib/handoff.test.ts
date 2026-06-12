import { describe, expect, it } from "vitest";
import type { ChatItem } from "./events";
import { buildHandoff, handoffFilename, HANDOFF_CAPS } from "./handoff";

let nextId = 0;
const user = (text: string): ChatItem => ({ kind: "user", id: ++nextId, text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", id: ++nextId, text, streaming: false });
const file = (path: string): ChatItem => ({ kind: "file", id: ++nextId, path });
const tool = (name: string, args: unknown): ChatItem => ({
  kind: "tool",
  id: ++nextId,
  name,
  args,
  status: "ok",
});

describe("buildHandoff", () => {
  it("renders the four sections from the chat items", () => {
    const md = buildHandoff({
      items: [
        user("add a --json flag"),
        tool("run_command", { command: "pnpm test" }),
        file("src/cli.ts"),
        assistant("Done.\n\nRemaining:\n- wire the docs\n- bump the version"),
      ],
      sessionId: "s-1",
      model: "deepseek-v4-flash",
      costUsd: 0.01234,
    });
    expect(md).toContain("# Session handoff");
    expect(md).toContain("- Model: deepseek-v4-flash");
    expect(md).toContain("- Session: s-1");
    expect(md).toContain("- Cost: $0.0123");
    expect(md).toContain("## Tasks\n\n- add a --json flag");
    expect(md).toContain("## Files touched\n\n- `src/cli.ts`");
    expect(md).toContain("## Commands run\n\n- `pnpm test`");
    expect(md).toContain("## Open questions\n\n- wire the docs\n- bump the version");
  });

  it("dedupes files and commands in first-seen order", () => {
    const md = buildHandoff({
      items: [
        user("t"),
        file("a.ts"),
        file("b.ts"),
        file("a.ts"),
        tool("run_command", { command: "pnpm test" }),
        tool("run_command", { command: "pnpm test" }),
        tool("read_file", { path: "ignored.ts" }),
      ],
      model: "m",
      costUsd: 0,
    });
    expect(md.match(/`a\.ts`/g)).toHaveLength(1);
    expect(md.indexOf("`a.ts`")).toBeLessThan(md.indexOf("`b.ts`"));
    expect(md.match(/`pnpm test`/g)).toHaveLength(1);
    expect(md).not.toContain("ignored.ts");
  });

  it("caps each section keeping the MOST RECENT entries", () => {
    const items: ChatItem[] = [];
    for (let i = 1; i <= HANDOFF_CAPS.tasks + 3; i++) items.push(user(`task ${i}`));
    const md = buildHandoff({ items, model: "m", costUsd: 0 });
    expect(md).toContain("- … 3 earlier omitted");
    expect(md).not.toContain("- task 3\n");
    expect(md).toContain(`- task ${HANDOFF_CAPS.tasks + 3}`);
  });

  it("uses placeholders for empty sections and all-bullet last messages", () => {
    const md = buildHandoff({
      items: [user("t"), assistant("- just\n- a list")], // whole message is bullets
      model: "m",
      costUsd: 0,
    });
    expect(md).toContain("(none)");
    expect(md).toContain("- (none — review the last assistant message for context)");
    const empty = buildHandoff({ items: [], model: "m", costUsd: 0 });
    expect(empty).toContain("(no user messages this session)");
  });
});

describe("handoffFilename", () => {
  it("stamps handoff-<timestamp>.md like the TUI", () => {
    expect(handoffFilename(new Date("2026-06-12T10:20:30.456Z"))).toBe("handoff-20260612T102030.md");
  });
});
