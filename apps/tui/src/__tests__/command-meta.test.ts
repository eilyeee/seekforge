import { describe, expect, it } from "vitest";
import { COMMAND_GROUPS, type CommandSpec } from "../commands.js";
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
