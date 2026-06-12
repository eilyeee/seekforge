import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHistory, createHistoryNav, loadHistory } from "../history.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-history-"));
  file = path.join(dir, "nested", "tui-history");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadHistory / appendHistory", () => {
  it("returns [] for a missing file", () => {
    expect(loadHistory(file)).toEqual([]);
  });

  it("round-trips entries oldest→newest, creating parent dirs", () => {
    appendHistory(file, "first");
    appendHistory(file, "second\nmultiline");
    expect(loadHistory(file)).toEqual(["first", "second\nmultiline"]);
  });

  it("skips corrupt lines", () => {
    appendHistory(file, "good");
    fs.appendFileSync(file, "not json{{\n");
    appendHistory(file, "also good");
    expect(loadHistory(file)).toEqual(["good", "also good"]);
  });

  it("skips an entry identical to the last one", () => {
    appendHistory(file, "same");
    appendHistory(file, "same");
    appendHistory(file, "other");
    appendHistory(file, "same");
    expect(loadHistory(file)).toEqual(["same", "other", "same"]);
  });

  it("caps the file at 200 entries", () => {
    for (let i = 0; i < 230; i += 1) appendHistory(file, `entry ${i}`);
    const entries = loadHistory(file);
    expect(entries).toHaveLength(200);
    expect(entries[0]).toBe("entry 30");
    expect(entries[199]).toBe("entry 229");
  });
});

describe("createHistoryNav", () => {
  it("first up() saves the draft and returns the newest entry", () => {
    const nav = createHistoryNav(["a", "b", "c"]);
    expect(nav.up("draft")).toBe("c");
    expect(nav.up("ignored")).toBe("b");
    expect(nav.up("ignored")).toBe("a");
  });

  it("up() at the oldest returns null and stays", () => {
    const nav = createHistoryNav(["a"]);
    expect(nav.up("d")).toBe("a");
    expect(nav.up("d")).toBeNull();
    expect(nav.down()).toBe("d"); // still one step from the draft
  });

  it("down() walks forward and restores the draft past the newest", () => {
    const nav = createHistoryNav(["a", "b"]);
    nav.up("my draft");
    nav.up("x");
    expect(nav.down()).toBe("b");
    expect(nav.down()).toBe("my draft");
    expect(nav.down()).toBeNull(); // already at the draft
  });

  it("up() with no entries returns null; down() at the draft returns null", () => {
    const nav = createHistoryNav([]);
    expect(nav.up("d")).toBeNull();
    expect(nav.down()).toBeNull();
  });

  it("reset() goes back to the draft position", () => {
    const nav = createHistoryNav(["a", "b"]);
    nav.up("d");
    nav.reset();
    expect(nav.down()).toBeNull();
    expect(nav.up("new draft")).toBe("b");
    expect(nav.down()).toBe("new draft");
  });
});
