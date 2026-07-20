import { describe, expect, it } from "vitest";
import {
  atBottomEdge,
  atToken,
  atTopEdge,
  createHistoryNav,
  filterCommands,
  fuzzyScore,
  historyKey,
  imageUploadSizeError,
  imageMarker,
  insertAtPath,
  insertImageMarker,
  isImagePath,
  listImageMarkers,
  removeImageMarker,
  splitImageMarkers,
  loadHistory,
  pushHistory,
  slashQuery,
  HISTORY_LIMIT,
  type ComposerCommand,
  type KVStorage,
} from "./composer";
import { MAX_UPLOAD_BYTES } from "@seekforge/shared/protocol-limits";

describe("imageUploadSizeError", () => {
  it("rejects oversized images before FileReader allocates a base64 copy", () => {
    expect(imageUploadSizeError(MAX_UPLOAD_BYTES)).toBeNull();
    expect(imageUploadSizeError(MAX_UPLOAD_BYTES + 1)).toMatch(/exceeds/);
  });
});

const cmd = (name: string): ComposerCommand => ({ name, hint: name, run: () => {} });

function memStorage(initial: Record<string, string> = {}): KVStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("fuzzyScore / filterCommands", () => {
  it("matches subsequences case-insensitively and rejects misses", () => {
    expect(fuzzyScore("mdl", "model")).not.toBeNull();
    expect(fuzzyScore("MDL", "model")).not.toBeNull();
    expect(fuzzyScore("xyz", "model")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks start-of-name matches above embedded ones", () => {
    const ranked = filterCommands("se", [cmd("new"), cmd("close"), cmd("sessions")]);
    expect(ranked.map((c) => c.name)).toEqual(["sessions", "close"]);
  });

  it("empty query keeps registry order and drops nothing", () => {
    const all = [cmd("new"), cmd("plan"), cmd("diff")];
    expect(filterCommands("", all).map((c) => c.name)).toEqual(["new", "plan", "diff"]);
  });
});

describe("slashQuery", () => {
  it("is active while typing the first token of a leading slash", () => {
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/mod", 4)).toBe("mod");
    expect(slashQuery("/mod", 2)).toBe("m");
  });

  it("is inactive for plain text, mid-text slashes, and after whitespace", () => {
    expect(slashQuery("hello", 5)).toBeNull();
    expect(slashQuery("a /cmd", 6)).toBeNull();
    expect(slashQuery("/new task", 9)).toBeNull();
    expect(slashQuery("/", 0)).toBeNull();
  });
});

describe("atToken / insertAtPath", () => {
  it("detects an @ at the start or after whitespace", () => {
    expect(atToken("@", 1)).toEqual({ start: 0, query: "" });
    expect(atToken("fix @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
    expect(atToken("a\n@x", 4)).toEqual({ start: 2, query: "x" });
  });

  it("does not trigger on emails or once whitespace follows", () => {
    expect(atToken("mail a@b", 8)).toBeNull();
    expect(atToken("@path done", 10)).toBeNull();
    expect(atToken("no token", 8)).toBeNull();
  });

  it("insertAtPath replaces the token and appends a space", () => {
    const token = atToken("fix @src/ap please", 11)!;
    const out = insertAtPath("fix @src/ap please", token, 11, "src/app.ts");
    expect(out.text).toBe("fix @src/app.ts  please");
    expect(out.caret).toBe("fix @src/app.ts ".length);
  });
});

describe("image markers", () => {
  it("numbers markers sequentially from the existing maximum", () => {
    expect(imageMarker("", "a.png")).toBe("[image #1: a.png]");
    expect(imageMarker("see [image #1: a.png] and [image #3: b.png]", "c.png")).toBe("[image #4: c.png]");
  });

  it("insertImageMarker pads with spaces only where needed", () => {
    const empty = insertImageMarker("", 0, 0, "a.png");
    expect(empty.text).toBe("[image #1: a.png]");
    expect(empty.caret).toBe(empty.text.length);

    const mid = insertImageMarker("fix this", 3, 3, "a.png");
    expect(mid.text).toBe("fix [image #1: a.png] this");

    const end = insertImageMarker("look at ", 8, 8, "a.png");
    expect(end.text).toBe("look at [image #1: a.png]");
  });

  it("replaces a selection range", () => {
    const out = insertImageMarker("a XXX b", 2, 5, "p.png");
    expect(out.text).toBe("a [image #1: p.png] b");
  });
});

describe("history storage", () => {
  it("loads [] for missing or corrupt entries", () => {
    const s = memStorage({ [historyKey("ws1")]: "not json" });
    expect(loadHistory(s, "ws1")).toEqual([]);
    expect(loadHistory(s, "other")).toEqual([]);
  });

  it("pushes entries per workspace, skipping consecutive duplicates", () => {
    const s = memStorage();
    pushHistory(s, "ws1", "first");
    pushHistory(s, "ws1", "first");
    pushHistory(s, "ws1", "second");
    pushHistory(s, "ws2", "elsewhere");
    expect(loadHistory(s, "ws1")).toEqual(["first", "second"]);
    expect(loadHistory(s, "ws2")).toEqual(["elsewhere"]);
  });

  it("caps at 100 entries", () => {
    const s = memStorage();
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) pushHistory(s, "ws1", `entry ${i}`);
    const entries = loadHistory(s, "ws1");
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]).toBe("entry 20");
    expect(entries[entries.length - 1]).toBe(`entry ${HISTORY_LIMIT + 19}`);
  });
});

describe("history navigation", () => {
  it("up() saves the draft, walks back, and stops at the oldest", () => {
    const nav = createHistoryNav(["one", "two"]);
    expect(nav.up("draft")).toBe("two");
    expect(nav.up("two")).toBe("one");
    expect(nav.up("one")).toBeNull();
  });

  it("down() walks forward and restores the draft past the newest", () => {
    const nav = createHistoryNav(["one", "two"]);
    expect(nav.down()).toBeNull();
    nav.up("my draft");
    nav.up("two");
    expect(nav.down()).toBe("two");
    expect(nav.down()).toBe("my draft");
    expect(nav.down()).toBeNull();
  });

  it("is inert with no history", () => {
    const nav = createHistoryNav([]);
    expect(nav.up("draft")).toBeNull();
    expect(nav.down()).toBeNull();
  });

  it("reset() returns to the draft position", () => {
    const nav = createHistoryNav(["one"]);
    nav.up("draft");
    nav.reset();
    expect(nav.down()).toBeNull();
    expect(nav.up("new draft")).toBe("one");
  });
});

describe("image markers", () => {
  it("isImagePath: by extension, case-insensitive", () => {
    expect(isImagePath(".seekforge/uploads/a.png")).toBe(true);
    expect(isImagePath("b.JPEG")).toBe(true);
    expect(isImagePath("c.webp")).toBe(true);
    expect(isImagePath("d.txt")).toBe(false);
    expect(isImagePath("noext")).toBe(false);
  });

  it("splitImageMarkers: separates prose from image markers", () => {
    const text = "look [image #1: .seekforge/uploads/a.png] here";
    expect(splitImageMarkers(text)).toEqual([
      { kind: "text", text: "look " },
      {
        kind: "image",
        marker: { n: 1, path: ".seekforge/uploads/a.png" },
        raw: "[image #1: .seekforge/uploads/a.png]",
      },
      { kind: "text", text: " here" },
    ]);
  });

  it("splitImageMarkers: a non-image marker stays literal text", () => {
    const text = "see [image #1: notes.txt] ok";
    expect(splitImageMarkers(text)).toEqual([{ kind: "text", text }]);
  });

  it("splitImageMarkers: handles multiple markers and plain text", () => {
    const text = "[image #1: a.png][image #2: b.jpg]end";
    const segs = splitImageMarkers(text);
    expect(segs.filter((s) => s.kind === "image")).toHaveLength(2);
    expect(segs[segs.length - 1]).toEqual({ kind: "text", text: "end" });
  });

  it("listImageMarkers: in order, images only", () => {
    expect(listImageMarkers("x [image #2: a.png] y [image #5: b.gif]")).toEqual([
      { n: 2, path: "a.png" },
      { n: 5, path: "b.gif" },
    ]);
    expect(listImageMarkers("no markers here")).toEqual([]);
  });

  it("removeImageMarker: strips the marker and tidies whitespace", () => {
    expect(removeImageMarker("a [image #1: a.png] b", { n: 1, path: "a.png" })).toBe("a b");
    expect(removeImageMarker("[image #1: a.png]", { n: 1, path: "a.png" })).toBe("");
    expect(removeImageMarker("hi", { n: 1, path: "a.png" })).toBe("hi");
  });
});

describe("edges", () => {
  it("atTopEdge: caret on the first line", () => {
    expect(atTopEdge("abc", 1)).toBe(true);
    expect(atTopEdge("ab\ncd", 4)).toBe(false);
    expect(atTopEdge("", 0)).toBe(true);
  });

  it("atBottomEdge: caret on the last line", () => {
    expect(atBottomEdge("abc", 1)).toBe(true);
    expect(atBottomEdge("ab\ncd", 1)).toBe(false);
    expect(atBottomEdge("ab\ncd", 4)).toBe(true);
  });
});
