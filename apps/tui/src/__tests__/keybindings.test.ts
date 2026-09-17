import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chordShadowWarnings,
  loadKeybindings,
  loadKeybindingsReport,
  mergeKeymap,
  parseKeySequence,
  parseKeySpec,
} from "../keybindings.js";
import { ACTION_IDS, actionScope, KEYMAP, resolveAction, resolveChord, type Binding } from "../keymap.js";

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
    // A shifted letter arrives from the terminal uppercased (matches toStroke).
    ["shift+a", { input: "A", shift: true }],
    // A bare uppercase letter keeps its case so it's bindable at all.
    ["A", { input: "A" }],
    // alt and option are spellings of meta (what Ink reports for Alt+key).
    ["alt+p", { input: "p", meta: true }],
    ["option+t", { input: "t", meta: true }],
  ])("parses %s", (spec, expected) => {
    expect(parseKeySpec(spec)).toEqual(expected);
  });

  it.each(["", "+", "ctrl+", "ctrl", "ctrl+ctrl+j", "ctrl+j+k", "notakey", "ctrl+foo", "alt+meta+p"])(
    "rejects %j",
    (spec) => {
      expect(parseKeySpec(spec)).toBeNull();
    },
  );
});

describe("parseKeySequence", () => {
  it("parses a single stroke and a chord", () => {
    expect(parseKeySequence("ctrl+e")).toEqual([{ input: "e", ctrl: true }]);
    expect(parseKeySequence("  ctrl+x   ctrl+e ")).toEqual([
      { input: "x", ctrl: true },
      { input: "e", ctrl: true },
    ]);
  });

  it("rejects malformed strokes and over-long chords", () => {
    expect(parseKeySequence("ctrl+x nope")).toBeNull();
    expect(parseKeySequence("a b c d")).toBeNull();
    expect(parseKeySequence("")).toBeNull();
  });
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

  it("skips unknown scopes/actions, bad specs, and malformed json — and says so", () => {
    write(home, {
      composer: { newline: "ctrl+", nonsense: "ctrl+x", submit: 5 },
      bogus: { submit: "ctrl+x" },
      overlay: "not-an-object",
    });
    const report = loadKeybindingsReport(workspace, home);
    expect(report.overrides).toEqual([]);
    expect(report.warnings).toHaveLength(5);
    const text = report.warnings.join("\n");
    expect(text).toMatch(/composer\.newline — cannot parse key spec "ctrl\+"/);
    expect(text).toMatch(/composer\.nonsense — unknown action/);
    expect(text).toMatch(/composer\.submit — the key spec must be a string/);
    expect(text).toMatch(/unknown scope "bogus"/);
    expect(text).toMatch(/"overlay" must map action names/);
    expect(loadKeybindings(workspace, home)).toEqual([]);

    writeFileSync(join(home, ".seekforge", "keybindings.json"), "{ not json");
    expect(loadKeybindingsReport(workspace, home)).toEqual({
      overrides: [],
      warnings: [expect.stringContaining("not valid JSON")],
    });
  });

  it("accepts every keymap action in its own scope", () => {
    const file: Record<string, Record<string, string>> = { composer: {}, overlay: {}, global: {} };
    for (const action of ACTION_IDS) {
      (file[actionScope(action)] as Record<string, string>)[action] = "ctrl+y";
    }
    write(home, file);
    const report = loadKeybindingsReport(workspace, home);
    expect(report.warnings).toEqual([]);
    expect(new Set(report.overrides.map((o) => o.action))).toEqual(new Set(ACTION_IDS));
  });

  it("rebinds the previously dropped global actions", () => {
    write(home, {
      global: {
        "toggle-verbose": "ctrl+y",
        "detach-run": "alt+b",
        suspend: "ctrl+x ctrl+z",
        "tab-new": "alt+n",
        "tab-cycle": "alt+]",
        "toggle-sidebar": "alt+e",
        "toggle-pager": "alt+l",
      },
      composer: { "paste-image": "alt+v" },
    });
    const table = mergeKeymap(KEYMAP, loadKeybindings(workspace, home));
    expect(resolveAction("composer", { input: "y", ctrl: true }, table)).toBe("toggle-verbose");
    expect(resolveAction("composer", { input: "o", ctrl: true }, table)).toBeUndefined();
    expect(resolveAction("composer", { input: "v", meta: true }, table)).toBe("paste-image");
    expect(resolveAction("composer", { input: "b", meta: true }, table)).toBe("detach-run");
    expect(resolveChord("composer", [{ input: "x", ctrl: true }], table)).toEqual({ kind: "pending" });
    expect(
      resolveChord(
        "composer",
        [
          { input: "x", ctrl: true },
          { input: "z", ctrl: true },
        ],
        table,
      ),
    ).toEqual({
      kind: "action",
      action: "suspend",
    });
  });

  it("warns when an action is bound in a scope that never runs it", () => {
    write(home, {
      overlay: { submit: "ctrl+y" },
      composer: { "toggle-pager": "ctrl+y" },
      global: { newline: "alt+j" },
    });
    const report = loadKeybindingsReport(workspace, home);
    // A composer action may sit in global (the composer falls back to it).
    expect(report.overrides).toEqual([{ scope: "global", action: "newline", key: { input: "j", meta: true } }]);
    expect(report.warnings).toEqual([
      expect.stringMatching(/overlay\.submit — this action runs in the "composer" scope/),
      expect.stringMatching(/composer\.toggle-pager — this action runs in the "global" scope/),
    ]);
  });

  it("refuses overlay chords", () => {
    write(home, { overlay: { "overlay-close": "ctrl+x q" } });
    expect(loadKeybindingsReport(workspace, home).warnings).toEqual([
      expect.stringMatching(/chords are supported in the composer and global scopes only/),
    ]);
  });
});

describe("chordShadowWarnings", () => {
  it("names the single-stroke binding a chord prefix hides", () => {
    const table = mergeKeymap(KEYMAP, [
      { scope: "composer", action: "external-editor", key: { input: "e", ctrl: true }, rest: [{ input: "x" }] },
    ]);
    expect(chordShadowWarnings(table)).toEqual([
      expect.stringContaining("global.toggle-sidebar (ctrl+e) is shadowed by the chord for external-editor"),
    ]);
    expect(chordShadowWarnings(KEYMAP)).toEqual([]);
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
    const merged = mergeKeymap(base, [{ scope: "composer", action: "delete-back", key: { input: "h", ctrl: true } }]);
    const deleteBack = merged.filter((b) => b.action === "delete-back");
    expect(deleteBack).toEqual([{ scope: "composer", action: "delete-back", key: { input: "h", ctrl: true } }]);
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
