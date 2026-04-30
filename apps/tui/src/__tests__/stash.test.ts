import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stashList, stashPop, stashPush } from "../stash.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-stash-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const stashFile = (): string => path.join(workspace, ".seekforge", "stash.json");

describe("stash", () => {
  it("lists [] when no stash file exists", () => {
    expect(stashList(workspace)).toEqual([]);
  });

  it("push/list round-trips oldest-first and returns the count", () => {
    expect(stashPush(workspace, "first draft")).toBe(1);
    expect(stashPush(workspace, "second\nmultiline draft")).toBe(2);
    expect(stashList(workspace)).toEqual(["first draft", "second\nmultiline draft"]);
  });

  it("pop is LIFO and rewrites the file", () => {
    stashPush(workspace, "first");
    stashPush(workspace, "second");
    expect(stashPop(workspace)).toBe("second");
    expect(stashList(workspace)).toEqual(["first"]);
    expect(stashPop(workspace)).toBe("first");
    expect(stashPop(workspace)).toBeNull();
  });

  it("pop on an empty stash returns null", () => {
    expect(stashPop(workspace)).toBeNull();
  });

  it("drops whitespace-only drafts without writing", () => {
    expect(stashPush(workspace, "   \n  ")).toBe(0);
    expect(fs.existsSync(stashFile())).toBe(false);
  });

  it("caps the stash at 20, pruning the oldest", () => {
    for (let i = 0; i < 25; i += 1) stashPush(workspace, `draft ${i}`);
    const entries = stashList(workspace);
    expect(entries).toHaveLength(20);
    expect(entries[0]).toBe("draft 5");
    expect(entries[19]).toBe("draft 24");
  });

  it("tolerates a corrupt file: list is empty and push recovers", () => {
    fs.mkdirSync(path.dirname(stashFile()), { recursive: true });
    fs.writeFileSync(stashFile(), "{not json[", "utf8");
    expect(stashList(workspace)).toEqual([]);
    expect(stashPop(workspace)).toBeNull();
    expect(stashPush(workspace, "fresh start")).toBe(1);
    expect(stashList(workspace)).toEqual(["fresh start"]);
  });

  it("filters non-string and empty entries from a tampered file", () => {
    fs.mkdirSync(path.dirname(stashFile()), { recursive: true });
    fs.writeFileSync(stashFile(), JSON.stringify(["good", 42, null, "", "also good"]), "utf8");
    expect(stashList(workspace)).toEqual(["good", "also good"]);
  });
});
