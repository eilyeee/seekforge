import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKeybindings, mergeKeymap, parseKeySpec } from "../keybindings.js";
import type { Binding } from "../keymap.js";

describe("parseKeySpec", () => {
  it.each([
    ["ctrl+j", { input: "j", ctrl: true }],
    ["shift+tab", { input: "", name: "tab", shift: true }],
    ["ctrl+shift+p", { input: "p", ctrl: true, shift: true }],
    ["meta+left", { input: "", name: "left", meta: true }],
    ["escape", { input: "", name: "escape" }],
    ["return", { input: "", name: "return" }],
    ["pageup", { input: "", name: "pageup" }],
    ["backspace", { input: "", name: "backspace" }],
    ["x", { input: "x" }],
    ["CTRL+G", { input: "g", ctrl: true }],
  ])("parses %s", (spec, expected) => {
    expect(parseKeySpec(spec)).toEqual(expected);
  });

  it.each(["", "+", "ctrl+", "ctrl", "ctrl+ctrl+j", "ctrl+j+k", "notakey", "ctrl+foo"])(
    "rejects %j",
    (spec) => {
      expect(parseKeySpec(spec)).toBeNull();
    },
  );
});

describe("loadKeybindings", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sf-kb-home-"));
    workspace = mkdtempSync(join(tmpdir(), "sf-kb-ws-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function write(root: string, content: unknown): void {
    mkdirSync(join(root, ".seekforge"), { recursive: true });
    writeFileSync(join(root, ".seekforge", "keybindings.json"), JSON.stringify(content));
  }

  it("returns [] when no files exist", () => {
    expect(loadKeybindings(workspace, home)).toEqual([]);
  });

  it("loads home overrides and lets project win per scope+action", () => {
    write(home, {
      composer: { newline: "ctrl+n", "external-editor": "ctrl+e" },
      global: { "cycle-approval": "shift+tab" },
    });
    write(workspace, { composer: { newline: "ctrl+o" } });

    const overrides = loadKeybindings(workspace, home);
    expect(overrides).toContainEqual({
      scope: "composer",
      action: "newline",
      key: { input: "o", ctrl: true },
    });
    expect(overrides).toContainEqual({
      scope: "composer",
      action: "external-editor",
      key: { input: "e", ctrl: true },
    });
    expect(overrides).toContainEqual({
      scope: "global",
      action: "cycle-approval",
      key: { input: "", name: "tab", shift: true },
    });
    expect(overrides).toHaveLength(3);
  });

  it("skips unknown scopes/actions, bad specs, and malformed json silently", () => {
    write(home, {
      composer: { newline: "ctrl+", nonsense: "ctrl+x" },
      bogus: { submit: "ctrl+x" },
      overlay: "not-an-object",
    });
    expect(loadKeybindings(workspace, home)).toEqual([]);

    writeFileSync(join(home, ".seekforge", "keybindings.json"), "{ not json");
    expect(loadKeybindings(workspace, home)).toEqual([]);
  });
});

describe("mergeKeymap", () => {
  const base: readonly Binding[] = [
    { scope: "composer", key: { input: "", name: "return" }, action: "submit" },
    { scope: "composer", key: { input: "", name: "backspace" }, action: "delete-back" },
    { scope: "composer", key: { input: "", name: "delete" }, action: "delete-back" },
    { scope: "global", key: { input: "c", ctrl: true }, action: "cancel-or-quit" },
  ];

  it("returns a copy of the base when there are no overrides", () => {
    expect(mergeKeymap(base, [])).toEqual(base);
  });

  it("replaces every base binding with the same scope+action", () => {
    const merged = mergeKeymap(base, [
      { scope: "composer", action: "delete-back", key: { input: "h", ctrl: true } },
    ]);
    const deleteBack = merged.filter((b) => b.action === "delete-back");
    expect(deleteBack).toEqual([
      { scope: "composer", action: "delete-back", key: { input: "h", ctrl: true } },
    ]);
    // Order otherwise preserved: submit first, cancel-or-quit last.
    expect(merged[0]?.action).toBe("submit");
    expect(merged[merged.length - 1]?.action).toBe("cancel-or-quit");
    expect(merged).toHaveLength(3);
  });

  it("appends overrides for scope+action pairs absent from the base", () => {
    const merged = mergeKeymap(base, [
      { scope: "global", action: "scroll-latest", key: { input: "", name: "pagedown", shift: true } },
    ]);
    expect(merged).toHaveLength(base.length + 1);
    expect(merged[merged.length - 1]).toEqual({
      scope: "global",
      action: "scroll-latest",
      key: { input: "", name: "pagedown", shift: true },
    });
  });

  it("scope matters: a composer override does not touch a global action", () => {
    const merged = mergeKeymap(base, [
      { scope: "composer", action: "cancel-or-quit", key: { input: "q", ctrl: true } },
    ]);
    expect(merged).toContainEqual({ scope: "global", key: { input: "c", ctrl: true }, action: "cancel-or-quit" });
    expect(merged).toContainEqual({ scope: "composer", action: "cancel-or-quit", key: { input: "q", ctrl: true } });
  });
});
