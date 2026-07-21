import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { unifiedDiff } from "../../src/tools/builtins/fs.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

describe("write_file", () => {
  it("creates a file with parent directories", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(call("write_file", { path: "deep/dir/a.txt", content: "hello" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "deep/dir/a.txt"), "utf8")).toBe("hello");
  });

  it("fails with 'exists' when the file exists and overwrite is not set", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "old");
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "new" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("exists");
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("old");
  });

  it("overwrites when overwrite is true", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "old");
    const res = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "new", overwrite: true }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("new");
  });

  it("refuses a symlink swapped in after checkpointing", async () => {
    const ws = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(path.dirname(ws), "seekforge-outside-"));
    const target = path.join(ws, "a.txt");
    const external = path.join(outside, "external.txt");
    fs.writeFileSync(target, "old");
    fs.writeFileSync(external, "outside");
    const ctx = makeCtx(ws, {
      checkpoint: () => {
        fs.rmSync(target);
        fs.symlinkSync(external, target);
      },
    });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "new", overwrite: true }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
    expect(fs.readFileSync(external, "utf8")).toBe("outside");
  });
});

describe("search_text", () => {
  function setup(): string {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/a.ts"), "const needle = 1;\nconst other = 2;\n");
    fs.writeFileSync(path.join(ws, "node_modules/dep/b.ts"), "const needle = 99;\n");
    return ws;
  }

  it("finds matches with file/line/text", async () => {
    const ws = setup();
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { matches: Array<{ file: string; line: number; text: string }> };
    expect(data.matches).toEqual([{ file: "src/a.ts", line: 1, text: "const needle = 1;" }]);
  });

  it("respects the default ignore list", async () => {
    const ws = setup();
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    const data = res.data as { matches: Array<{ file: string }> };
    expect(data.matches.every((m) => !m.file.includes("node_modules"))).toBe(true);
  });

  it("skips binary files", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    const data = res.data as { matches: unknown[] };
    expect(data.matches).toEqual([]);
  });

  it("rejects regexes with catastrophic backtracking shapes", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "long.txt"), `${"a".repeat(100_000)}!\n`);
    const res = await dispatcher.execute(call("search_text", { pattern: "(a+)+$" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unsafe_regex");
  });
});

describe("search_text (grep parity)", () => {
  function setup(): string {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src/a.ts"), "line1\nline2\nneedle here\nline4\nline5\n");
    fs.writeFileSync(path.join(ws, "src/b.js"), "another needle\n");
    fs.writeFileSync(path.join(ws, "notes.md"), "no match here\n");
    return ws;
  }

  it("includes contextLines before and after each match", async () => {
    const ws = setup();
    const res = await dispatcher.execute(
      call("search_text", { pattern: "needle", path: "src/a.ts", contextLines: 2 }),
      makeCtx(ws),
    );
    const data = res.data as {
      matches: Array<{ line: number; text: string; context: { before: string[]; after: string[] } }>;
    };
    expect(data.matches).toHaveLength(1);
    const m = data.matches[0]!;
    expect(m.line).toBe(3);
    expect(m.text).toBe("needle here");
    expect(m.context.before).toEqual(["line1", "line2"]);
    expect(m.context.after).toEqual(["line4", "line5"]);
  });

  it("glob filter restricts which files are searched", async () => {
    const ws = setup();
    const res = await dispatcher.execute(call("search_text", { pattern: "needle", glob: "*.ts" }), makeCtx(ws));
    const data = res.data as { matches: Array<{ file: string }> };
    expect(data.matches.map((m) => m.file)).toEqual(["src/a.ts"]);
  });

  it("filesWithMatches returns just file paths", async () => {
    const ws = setup();
    const res = await dispatcher.execute(
      call("search_text", { pattern: "needle", filesWithMatches: true }),
      makeCtx(ws),
    );
    const data = res.data as { files: string[]; matches?: unknown };
    expect([...data.files].sort()).toEqual(["src/a.ts", "src/b.js"]);
    expect(data.matches).toBeUndefined();
  });

  it("multiline lets the pattern span newlines", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "f.ts"), "start\nfoo\nbar\nend\n");
    const single = await dispatcher.execute(call("search_text", { pattern: "foo\\nbar", path: "f.ts" }), makeCtx(ws));
    expect((single.data as { matches: unknown[] }).matches).toEqual([]);
    const multi = await dispatcher.execute(
      call("search_text", { pattern: "foo\\nbar", path: "f.ts", multiline: true }),
      makeCtx(ws),
    );
    const data = multi.data as { matches: Array<{ line: number }> };
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]!.line).toBe(2);
  });

  it("maxMatches caps results and flags truncation", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: 10 }, () => "needle").join("\n");
    fs.writeFileSync(path.join(ws, "many.txt"), lines + "\n");
    const res = await dispatcher.execute(call("search_text", { pattern: "needle", maxMatches: 3 }), makeCtx(ws));
    const data = res.data as { matches: unknown[]; truncated: boolean };
    expect(data.matches).toHaveLength(3);
    expect(data.truncated).toBe(true);
  });

  it("rejects invalid context and result-count bounds", async () => {
    const ws = setup();
    for (const args of [
      { pattern: "needle", contextLines: -1 },
      { pattern: "needle", contextLines: 1.5 },
      { pattern: "needle", maxMatches: 0 },
      { pattern: "needle", maxMatches: 1.5 },
    ]) {
      const res = await dispatcher.execute(call("search_text", args), makeCtx(ws));
      expect(res, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
  });
});

describe("list_files", () => {
  it("lists recursively, sorted, honoring the ignore list", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/b.ts"), "");
    fs.writeFileSync(path.join(ws, "src/a.ts"), "");
    fs.writeFileSync(path.join(ws, "README.md"), "");
    const res = await dispatcher.execute(call("list_files", {}), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { entries: string[] };
    expect(data.entries).toEqual(["README.md", "src/", "src/a.ts", "src/b.ts"]);
  });

  it("rejects negative and fractional recursion depths", async () => {
    const ws = makeWorkspace();
    for (const maxDepth of [-1, 1.5]) {
      const res = await dispatcher.execute(call("list_files", { maxDepth }), makeCtx(ws));
      expect(res, String(maxDepth)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
  });
});

describe("read_file", () => {
  it("reads a line range", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "f.txt"), "l1\nl2\nl3\nl4\n");
    const res = await dispatcher.execute(call("read_file", { path: "f.txt", offset: 2, limit: 2 }), makeCtx(ws));
    expect(res.ok).toBe(true);
    expect((res.data as { content: string }).content).toBe("l2\nl3");
  });

  it("rejects oversized files before buffering them", async () => {
    const ws = makeWorkspace();
    const file = path.join(ws, "huge.txt");
    fs.writeFileSync(file, "x");
    fs.truncateSync(file, 5 * 1024 * 1024 + 1);
    const res = await dispatcher.execute(call("read_file", { path: "huge.txt" }), makeCtx(ws));
    expect(res).toMatchObject({ ok: false, error: { code: "too_large" } });
  });

  it("rejects invalid line-range indices", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "f.txt"), "l1\nl2\n");
    for (const args of [
      { path: "f.txt", offset: 0 },
      { path: "f.txt", offset: 1.5 },
      { path: "f.txt", limit: -1 },
      { path: "f.txt", limit: 1.5 },
    ]) {
      const res = await dispatcher.execute(call("read_file", args), makeCtx(ws));
      expect(res, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
  });

  it("rejects invalid repo-map sizing arguments before scanning", async () => {
    const ws = makeWorkspace();
    for (const args of [{ maxDepth: -1 }, { maxDepth: 1.5 }, { maxFiles: -1 }, { maxFiles: 1.5 }]) {
      const res = await dispatcher.execute(call("repo_map", args), makeCtx(ws));
      expect(res, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    }
  });

  it("denies sensitive files", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
    const res = await dispatcher.execute(call("read_file", { path: ".env" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("sensitive_path");
  });

  it("appends a symbol outline when a code file is truncated", async () => {
    const ws = makeWorkspace();
    const big = "export function head() {}\n" + "// filler line padding\n".repeat(3000) + "export function tail() {}\n";
    fs.writeFileSync(path.join(ws, "big.ts"), big);
    const res = await dispatcher.execute(call("read_file", { path: "big.ts" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.meta?.truncated).toBe(true);
    const data = res.data as { outline?: string };
    expect(data.outline).toContain("head");
    expect(data.outline).toContain("tail"); // beyond the cut — discoverable via the outline
  });

  it("does not add an outline when not truncated", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "small.ts"), "export function f() {}\n");
    const res = await dispatcher.execute(call("read_file", { path: "small.ts" }), makeCtx(ws));
    expect((res.data as { outline?: string }).outline).toBeUndefined();
  });
});

describe("edit-review preview (write tools)", () => {
  // Capture the PermissionRequest the dispatcher hands to confirm(): set
  // approvalMode "confirm" so write tools prompt, and approve so the write
  // still happens. This exercises the full classify → confirmWithUser seam.
  async function captureRequest(
    ws: string,
    name: string,
    args: unknown,
  ): Promise<{ ok: boolean; preview?: { path: string; diff: string } }> {
    let preview: { path: string; diff: string } | undefined;
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm" },
      confirm: async (req) => {
        preview = req.preview;
        return true;
      },
    });
    const res = await dispatcher.execute(call(name, args), ctx);
    return { ok: res.ok, preview };
  }

  it("write_file attaches a current→proposed diff when overwriting", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "line1\nline2\n");
    const { ok, preview } = await captureRequest(ws, "write_file", {
      path: "a.txt",
      content: "line1\nCHANGED\n",
      overwrite: true,
    });
    expect(ok).toBe(true);
    expect(preview?.path).toBe("a.txt");
    expect(preview?.diff).toContain("--- a/a.txt");
    expect(preview?.diff).toContain("+++ b/a.txt");
    expect(preview?.diff).toContain("-line2");
    expect(preview?.diff).toContain("+CHANGED");
    expect(preview?.diff).toContain(" line1"); // unchanged context line
  });

  it("write_file diff treats a new file as a creation (no current content)", async () => {
    const ws = makeWorkspace();
    const { ok, preview } = await captureRequest(ws, "write_file", {
      path: "new.txt",
      content: "hello\nworld\n",
    });
    expect(ok).toBe(true);
    expect(preview?.diff).toContain("+hello");
    expect(preview?.diff).toContain("+world");
    // No deletion body lines (the "--- a/" header line is metadata, not a del).
    const delBody = preview!.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(delBody).toHaveLength(0);
  });

  it("apply_patch attaches a diff of the applied edits", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\nbeta\ngamma\n");
    const { ok, preview } = await captureRequest(ws, "apply_patch", {
      path: "a.txt",
      edits: [{ oldString: "beta", newString: "BETA" }],
    });
    expect(ok).toBe(true);
    expect(preview?.path).toBe("a.txt");
    expect(preview?.diff).toContain("-beta");
    expect(preview?.diff).toContain("+BETA");
  });

  it("omits the preview when apply_patch targets a missing file (graceful)", async () => {
    const ws = makeWorkspace();
    let sawRequest = false;
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm" },
      confirm: async (req) => {
        sawRequest = true;
        expect(req.preview).toBeUndefined();
        return true;
      },
    });
    const res = await dispatcher.execute(
      call("apply_patch", { path: "missing.txt", edits: [{ oldString: "x", newString: "y" }] }),
      ctx,
    );
    expect(sawRequest).toBe(true);
    // The run itself then fails because the file does not exist.
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
  });

  it("omits the preview when an apply_patch edit does not match (graceful)", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
    const { preview } = await captureRequest(ws, "apply_patch", {
      path: "a.txt",
      edits: [{ oldString: "does-not-exist", newString: "z" }],
    });
    expect(preview).toBeUndefined();
  });

  it("truncates very large diffs with a marker", async () => {
    const ws = makeWorkspace();
    const big = Array.from({ length: 1000 }, (_, i) => `old-${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(ws, "big.txt"), big);
    const next = Array.from({ length: 1000 }, (_, i) => `new-${i}`).join("\n") + "\n";
    const { preview } = await captureRequest(ws, "write_file", {
      path: "big.txt",
      content: next,
      overwrite: true,
    });
    expect(preview).toBeDefined();
    expect(preview?.diff).toContain("more lines truncated");
    // Body capped at 400 lines + header(2) + marker; comfortably under 2000.
    expect(preview!.diff.split("\n").length).toBeLessThan(420);
  });
});

describe("unifiedDiff prefix/suffix trimming (must stay byte-identical to the naive LCS)", () => {
  /**
   * The ORIGINAL untrimmed algorithm, verbatim — full (n+1)×(m+1) LCS table
   * plus the same emit walk — kept inline as the reference oracle. Any output
   * difference from the trimmed unifiedDiff is a regression.
   */
  function naiveUnifiedDiff(before: string | null, after: string, relPath: string): string {
    const split = (text: string): string[] => {
      if (text === "") return [];
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines;
    };
    const a = split(before ?? "");
    const b = split(after);
    const header = `--- a/${relPath}\n+++ b/${relPath}`;
    const n = a.length;
    const m = b.length;
    const body: string[] = [];
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        body.push(` ${a[i]}`);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        body.push(`-${a[i]}`);
        i++;
      } else {
        body.push(`+${b[j]}`);
        j++;
      }
    }
    while (i < n) body.push(`-${a[i++]}`);
    while (j < m) body.push(`+${b[j++]}`);
    body.unshift(`@@ -${n > 0 ? 1 : 0},${n} +${m > 0 ? 1 : 0},${m} @@`);
    // The MAX_PREVIEW_DIFF_LINES cap, verbatim, so long diffs compare equal too.
    let lines = body;
    if (lines.length > 400) {
      const hidden = lines.length - 400;
      lines = [...lines.slice(0, 400), `@@ … ${hidden} more lines truncated @@`];
    }
    return `${header}\n${lines.join("\n")}`;
  }

  const expectSame = (before: string | null, after: string): void => {
    expect(unifiedDiff(before, after, "f.txt")).toBe(naiveUnifiedDiff(before, after, "f.txt"));
  };

  it("matches the naive diff for an edit at the very start", () => {
    expectSame("first\nb\nc\nd\n", "FIRST\nb\nc\nd\n");
  });

  it("matches the naive diff for an edit at the very end", () => {
    expectSame("a\nb\nc\nlast\n", "a\nb\nc\nLAST\n");
  });

  it("matches the naive diff for a pure append (before is a full prefix of after)", () => {
    expectSame("a\nb\n", "a\nb\nc\nd\n");
  });

  it("matches the naive diff for a pure prepend and a pure truncation", () => {
    expectSame("c\nd\n", "a\nb\nc\nd\n");
    expectSame("a\nb\nc\nd\n", "a\nb\n");
  });

  it("matches the naive diff for creation, emptying, and identical content", () => {
    expectSame(null, "a\nb\n");
    expectSame("a\nb\n", "");
    expectSame("a\nb\nc\n", "a\nb\nc\n");
  });

  it("matches the naive diff when a trimmed-suffix line equals a middle line (tie-break boundary)", () => {
    // Adversarial case: naive "diff only the middle" would emit -x,+s,␣s here
    // while the untrimmed walk emits -x,␣s,+s (it matches a's middle "s"
    // against b's first line, across the trim boundary). The O(1) full-table
    // accessor must reproduce the untrimmed walk exactly.
    expectSame("x\ns\n", "s\ns\n");
    expectSame("s\ns\n", "x\ns\n"); // mirrored
    expectSame("p\nx\ns\ns\n", "p\ns\ns\ns\n"); // with a common prefix too
  });

  it("matches the naive diff on a large file with a tiny middle edit", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line-${i}`);
    const before = `${lines.join("\n")}\n`;
    const edited = [...lines];
    edited[600] = "CHANGED";
    expectSame(before, `${edited.join("\n")}\n`);
  });

  it("matches the naive diff on repetitive low-alphabet inputs (deterministic fuzz)", () => {
    // Small alphabet + short lengths maximize ties and boundary matches — the
    // exact conditions where a naive trim diverges. Deterministic LCG seed.
    let seed = 42;
    const rand = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const alphabet = ["a", "b", "c"];
    const doc = (): string => {
      const len = rand(13);
      return len === 0 ? "" : `${Array.from({ length: len }, () => alphabet[rand(3)]!).join("\n")}\n`;
    };
    for (let caseNo = 0; caseNo < 300; caseNo++) {
      const before = doc();
      const after = doc();
      expect(unifiedDiff(before, after, "f.txt"), `case ${caseNo}: ${JSON.stringify({ before, after })}`).toBe(
        naiveUnifiedDiff(before, after, "f.txt"),
      );
    }
  });

  it("keeps the del-all/add-all fallback for files over the 4000-line guard", () => {
    const before = `${Array.from({ length: 4001 }, (_, i) => `l${i}`).join("\n")}\n`;
    const after = `${Array.from({ length: 4001 }, (_, i) => (i === 7 ? "EDIT" : `l${i}`)).join("\n")}\n`;
    const diff = unifiedDiff(before, after, "f.txt");
    // header(2) + hunk(1); the preview cap appends a "@@ … truncated @@" marker.
    const bodyLines = diff
      .split("\n")
      .slice(3)
      .filter((l) => !l.startsWith("@@"));
    // Untrimmed behavior preserved: everything deleted then re-added, no context lines.
    expect(bodyLines.length).toBeGreaterThan(0);
    expect(bodyLines.every((l) => l.startsWith("-") || l.startsWith("+"))).toBe(true);
  });
});
