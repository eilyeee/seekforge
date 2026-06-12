import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listOutputStyles, resolveOutputStyle } from "../../src/agent/index.js";

let workspace: string;
let home: string;
const savedHome = process.env.SEEKFORGE_HOME;

function writeStyle(dir: string, name: string, content: string): void {
  const styles = join(dir, ".seekforge", "output-styles");
  mkdirSync(styles, { recursive: true });
  writeFileSync(join(styles, `${name}.md`), content);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "sf-style-ws-"));
  home = mkdtempSync(join(tmpdir(), "sf-style-home-"));
  process.env.SEEKFORGE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = savedHome;
});

describe("listOutputStyles", () => {
  it("lists the four builtins, then custom files (project + user)", () => {
    writeStyle(workspace, "pirate", "Arr");
    writeStyle(home, "formal", "Be formal");
    const list = listOutputStyles(workspace);
    expect(list.slice(0, 4).map((s) => s.name)).toEqual(["default", "concise", "explanatory", "learning"]);
    expect(list.slice(0, 4).every((s) => s.kind === "builtin")).toBe(true);
    const custom = list.filter((s) => s.kind === "custom").map((s) => s.name).sort();
    expect(custom).toEqual(["formal", "pirate"]);
  });

  it("does not duplicate a custom file that shadows a builtin name", () => {
    writeStyle(workspace, "concise", "override");
    const names = listOutputStyles(workspace).map((s) => s.name);
    expect(names.filter((n) => n === "concise")).toHaveLength(1);
  });
});

describe("resolveOutputStyle", () => {
  it("resolves builtins and custom files; throws on unknown", () => {
    expect(resolveOutputStyle("default", workspace)).toBeUndefined();
    expect(resolveOutputStyle("concise", workspace)).toContain("Concise");
    writeStyle(workspace, "pirate", "---\ndescription: x\n---\nSpeak like a pirate.");
    expect(resolveOutputStyle("pirate", workspace)).toBe("Speak like a pirate.");
    expect(() => resolveOutputStyle("nope", workspace)).toThrow();
  });
});
