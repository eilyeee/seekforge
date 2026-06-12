import { describe, expect, it } from "vitest";
import {
  buildTree,
  moveCursor,
  toggleDir,
  visibleNodes,
  type TreeState,
} from "../file-tree.js";

const FILES = [
  "README.md",
  "src/index.ts",
  "src/components/App.tsx",
  "src/components/Box.tsx",
  "src/util.ts",
  "assets/logo.png",
] as const;

function state(overrides?: Partial<TreeState>): TreeState {
  return { nodes: buildTree(FILES), expanded: new Set(), cursor: 0, ...overrides };
}

describe("buildTree", () => {
  it("derives directories and sorts dirs-first alpha per level", () => {
    const nodes = buildTree(FILES);
    expect(nodes.map((n) => n.path)).toEqual([
      "assets",
      "assets/logo.png",
      "src",
      "src/components",
      "src/components/App.tsx",
      "src/components/Box.tsx",
      "src/index.ts",
      "src/util.ts",
      "README.md",
    ]);
  });

  it("assigns depth and dir flags per level", () => {
    const nodes = buildTree(FILES);
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    expect(byPath.get("src")).toMatchObject({ name: "src", dir: true, depth: 0 });
    expect(byPath.get("src/components")).toMatchObject({ dir: true, depth: 1 });
    expect(byPath.get("src/components/App.tsx")).toMatchObject({ name: "App.tsx", dir: false, depth: 2 });
    expect(byPath.get("README.md")).toMatchObject({ dir: false, depth: 0 });
  });

  it("sorts case-insensitively within a group", () => {
    const nodes = buildTree(["b.ts", "A.ts", "c.ts"]);
    expect(nodes.map((n) => n.name)).toEqual(["A.ts", "b.ts", "c.ts"]);
  });

  it("handles an empty scan", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("visibleNodes", () => {
  it("shows only top-level entries when nothing is expanded", () => {
    const nodes = buildTree(FILES);
    expect(visibleNodes(nodes, new Set()).map((n) => n.path)).toEqual([
      "assets",
      "src",
      "README.md",
    ]);
  });

  it("expanding a dir reveals its children but keeps nested dirs collapsed", () => {
    const nodes = buildTree(FILES);
    expect(visibleNodes(nodes, new Set(["src"])).map((n) => n.path)).toEqual([
      "assets",
      "src",
      "src/components",
      "src/index.ts",
      "src/util.ts",
      "README.md",
    ]);
  });

  it("a nested expansion only counts when every ancestor is expanded", () => {
    const nodes = buildTree(FILES);
    // src/components expanded but src collapsed → nothing under src shows.
    expect(visibleNodes(nodes, new Set(["src/components"])).map((n) => n.path)).toEqual([
      "assets",
      "src",
      "README.md",
    ]);
    expect(visibleNodes(nodes, new Set(["src", "src/components"])).map((n) => n.path)).toEqual([
      "assets",
      "src",
      "src/components",
      "src/components/App.tsx",
      "src/components/Box.tsx",
      "src/index.ts",
      "src/util.ts",
      "README.md",
    ]);
  });
});

describe("toggleDir", () => {
  it("expands then collapses without mutating the original state", () => {
    const s0 = state();
    const s1 = toggleDir(s0, "src");
    expect(s1.expanded.has("src")).toBe(true);
    expect(s0.expanded.has("src")).toBe(false);
    const s2 = toggleDir(s1, "src");
    expect(s2.expanded.has("src")).toBe(false);
  });

  it("clamps the cursor when a collapse shrinks the visible list", () => {
    let s = state({ expanded: new Set(["src", "src/components"]) });
    const visible = visibleNodes(s.nodes, s.expanded);
    s = { ...s, cursor: visible.length - 1 }; // on README.md (index 7)
    const collapsed = toggleDir(s, "src");
    const after = visibleNodes(collapsed.nodes, collapsed.expanded);
    expect(after).toHaveLength(3);
    expect(collapsed.cursor).toBe(2); // clamped onto the last visible row
  });
});

describe("moveCursor", () => {
  it("moves over visible nodes and clamps at both ends", () => {
    let s = state(); // 3 visible rows
    s = moveCursor(s, +1);
    expect(s.cursor).toBe(1);
    s = moveCursor(s, +10);
    expect(s.cursor).toBe(2); // clamped to visible count, not full node count
    s = moveCursor(s, -99);
    expect(s.cursor).toBe(0);
  });

  it("uses the expanded visible list as its range", () => {
    let s = state({ expanded: new Set(["src"]) }); // 6 visible rows
    s = moveCursor(s, +10);
    expect(s.cursor).toBe(5);
  });

  it("stays at 0 on an empty tree", () => {
    const s = moveCursor({ nodes: [], expanded: new Set(), cursor: 0 }, +1);
    expect(s.cursor).toBe(0);
  });
});
