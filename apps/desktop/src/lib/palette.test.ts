import { describe, expect, it } from "vitest";
import { filterPaletteItems, type PaletteItem } from "./palette";

const items: PaletteItem[] = [
  { id: "view:chat", label: "Open Chat", section: "views", view: "chat" },
  { id: "view:files", label: "Open Files", section: "views", view: "files" },
  { id: "view:git", label: "Open Source Control", section: "views", view: "git" },
  { id: "action:new", label: "New session", section: "actions", run: () => {} },
  { id: "action:open", label: "Open folder…", section: "actions", run: () => {} },
];

describe("filterPaletteItems", () => {
  it("returns everything in registry order for an empty query", () => {
    const out = filterPaletteItems("", items);
    expect(out.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it("trims whitespace-only queries to match everything", () => {
    expect(filterPaletteItems("   ", items)).toHaveLength(items.length);
  });

  it("fuzzy-matches against the label and drops misses", () => {
    const out = filterPaletteItems("git", items);
    expect(out.some((i) => i.id === "view:git")).toBe(true);
    expect(out.some((i) => i.id === "action:new")).toBe(false);
  });

  it("ranks a closer match ahead of a looser one", () => {
    const out = filterPaletteItems("files", items);
    expect(out[0]!.id).toBe("view:files");
  });

  it("returns nothing when no label contains the query subsequence", () => {
    expect(filterPaletteItems("zzz", items)).toEqual([]);
  });
});
