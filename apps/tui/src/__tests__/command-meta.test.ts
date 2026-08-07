import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, COMMAND_GROUPS, type CommandSpec } from "../commands.js";
import { setLocale } from "../strings.js";
import { helpRows, selectableIndices, type HelpRow } from "../command-meta.js";

const sample: CommandSpec[] = [
  { name: "help", summary: "show all commands", group: "info" },
  { name: "new", summary: "start a fresh session", group: "session" },
  { name: "resume", args: "<id>", summary: "continue an existing session", group: "session" },
  { name: "diff", summary: "git diff of the working tree", group: "review" },
];

describe("helpRows", () => {
  it("emits groups in COMMAND_GROUPS order with header rows", () => {
    const rows = helpRows(sample);
    expect(rows.map((r) => (r.kind === "header" ? r.text : r.name))).toEqual([
      "── Session ──",
      "new",
      "resume",
      "── Review & history ──",
      "diff",
      "── Info ──",
      "help",
    ]);
  });

  it("skips groups with no commands", () => {
    const rows = helpRows(sample);
    const headers = rows.filter((r): r is HelpRow & { kind: "header" } => r.kind === "header");
    expect(headers).toHaveLength(3);
    expect(headers.map((h) => h.text)).not.toContain("── Settings ──");
  });

  it("builds labels as /name with args appended when present", () => {
    const rows = helpRows(sample);
    const resume = rows.find((r) => r.kind === "command" && r.name === "resume");
    const help = rows.find((r) => r.kind === "command" && r.name === "help");
    expect(resume).toMatchObject({ label: "/resume <id>", summary: "continue an existing session" });
    expect(help).toMatchObject({ label: "/help" });
  });

  it("defaults to the full registry and covers every group with members", () => {
    const rows = helpRows();
    const headerTexts = rows.filter((r) => r.kind === "header").map((r) => (r as { text: string }).text);
    // Every registry group has at least one command today.
    expect(headerTexts).toEqual(COMMAND_GROUPS.map(([, title]) => `── ${title} ──`));
  });

  it("returns no rows for an empty spec list", () => {
    expect(helpRows([])).toEqual([]);
  });
});

describe("selectableIndices", () => {
  it("returns the indices of command rows only", () => {
    const rows = helpRows(sample);
    expect(selectableIndices(rows)).toEqual([1, 2, 4, 6]);
    for (const i of selectableIndices(rows)) expect(rows[i]?.kind).toBe("command");
  });

  it("is empty when there are no rows", () => {
    expect(selectableIndices([])).toEqual([]);
  });
});

describe("localized help", () => {
  afterEach(() => {
    setLocale("en");
  });

  /**
   * The palette and /help were the one surface of a bilingual TUI that was
   * always English: 54 command summaries and 7 group headings written inline in
   * commands.ts and rendered straight to the screen, so a zh-CN user got
   * Chinese chrome around an English command list.
   */
  it("translates every command summary and group heading", () => {
    setLocale("zh-CN");
    const rows = helpRows();
    const headers = rows.filter((r) => r.kind === "header");
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.kind === "header" && header.text, header.kind === "header" ? header.text : "").toMatch(/[一-鿿]/);
    }
    for (const row of rows) {
      if (row.kind !== "command") continue;
      // The label keeps its ASCII "/name <args>" shape — only the prose moves.
      expect(row.label.startsWith("/"), row.name).toBe(true);
      expect(row.summary, row.name).toMatch(/[一-鿿]/);
    }
  });

  it("keeps the English inline in the registry authoritative for en", () => {
    setLocale("en");
    for (const row of helpRows()) {
      if (row.kind !== "command") continue;
      const spec = COMMANDS.find((c) => c.name === row.name);
      expect(row.summary, row.name).toBe(spec?.summary);
    }
  });

  it("falls back to the registry English for a command with no translation", () => {
    setLocale("zh-CN");
    // A command added without a strings.ts entry must still read, not render
    // its own key.
    const rows = helpRows([{ name: "brand-new", summary: "does a new thing", group: "info" }]);
    const command = rows.find((r) => r.kind === "command");
    expect(command?.kind === "command" && command.summary).toBe("does a new thing");
  });
});
