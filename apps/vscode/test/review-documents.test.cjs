const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REVIEW_SCHEME,
  ReviewStore,
  createReviewDocuments,
  diffSides,
  parseReviewPath,
  reviewPath,
} = require("../src/review-documents.cjs");

// Fixtures are verbatim output of packages/core/src/tools/diff.ts `unifiedDiff`.
const EDIT = "--- a/src/x.sql\n+++ b/src/x.sql\n@@ -1,4 +1,4 @@\n a\n--- sql comment\n+++ added\n b\n-c\n+C";
const CREATE = "--- a/src/new.ts\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+new\n+file";

function truncatedFixture() {
  const body = ["@@ -1,500 +1,500 @@", ...Array.from({ length: 399 }, (_, i) => `-l${i}`)];
  return ["--- a/big.txt", "+++ b/big.txt", ...body, "@@ … 601 more lines truncated @@"].join("\n");
}

test("rebuilds both whole files from a core edit preview", () => {
  const [file, ...rest] = diffSides(EDIT);
  assert.equal(rest.length, 0);
  assert.equal(file.path, "src/x.sql");
  assert.equal(file.created, false);
  assert.equal(file.truncated, false);
  // A removed line that renders as `--- …` is content, not a new file header.
  assert.equal(file.original, "a\n-- sql comment\nb\nc");
  assert.equal(file.proposed, "a\n++ added\nb\nC");
});

test("a creation has an empty original side", () => {
  const [file] = diffSides(CREATE);
  assert.equal(file.created, true);
  assert.equal(file.original, "");
  assert.equal(file.proposed, "new\nfile");
});

test("a truncated preview says so on both sides instead of posing as the whole file", () => {
  const [file] = diffSides(truncatedFixture());
  assert.equal(file.truncated, true);
  assert.match(file.original, /^l0\nl1\n/);
  assert.match(file.original, /601 more diff line\(s\) were not included$/);
  assert.match(file.proposed, /^… the preview stopped here; 601 more/);
});

test("splits a multi-file preview (lsp_rename joins per-file diffs with a newline)", () => {
  const files = diffSides(`${EDIT}\n${CREATE}`);
  assert.deepEqual(
    files.map((file) => file.path),
    ["src/x.sql", "src/new.ts"],
  );
  assert.equal(files[1].proposed, "new\nfile");
});

test("text that is not a unified diff yields no files", () => {
  assert.deepEqual(diffSides("just words"), []);
  assert.deepEqual(diffSides(""), []);
  assert.deepEqual(diffSides(undefined), []);
  // A header without a hunk is not a file section.
  assert.deepEqual(diffSides("--- a/x\n+++ b/x\nnot a hunk"), []);
});

test("a hunk whose body disagrees with its counts stops at the disagreement", () => {
  const [file] = diffSides("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n?garbage\n-old");
  assert.equal(file.original, "same");
  assert.equal(file.proposed, "same");
});

test("the review store evicts the oldest review first", () => {
  const store = new ReviewStore(2);
  const first = store.add("a", "b");
  const second = store.add("c", "d");
  const third = store.add("e", "f");
  assert.equal(store.get(first, "original"), undefined);
  assert.equal(store.get(second, "proposed"), "d");
  assert.equal(store.get(third, "original"), "e");
  assert.equal(store.get(third, "neither"), undefined);
});

test("review paths keep the basename and round-trip to their id and side", () => {
  assert.equal(reviewPath("r3", "proposed", "/repo/src/app.ts"), "/r3/proposed/app.ts");
  assert.equal(reviewPath("r3", "original", "C:\\repo\\app.ts"), "/r3/original/app.ts");
  assert.deepEqual(parseReviewPath("/r3/proposed/app.ts"), { id: "r3", side: "proposed" });
  assert.equal(parseReviewPath("/r3/elsewhere/app.ts"), undefined);
  assert.equal(parseReviewPath("/../etc/passwd"), undefined);
});

function fakeVscode() {
  const calls = [];
  let provider;
  return {
    calls,
    provider: () => provider,
    api: {
      Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }) },
      workspace: {
        registerTextDocumentContentProvider: (scheme, value) => {
          assert.equal(scheme, REVIEW_SCHEME);
          provider = value;
          return { dispose: () => calls.push(["dispose"]) };
        },
      },
      commands: { executeCommand: async (...args) => calls.push(args) },
    },
  };
}

test("opens the native diff editor over read-only review documents", async () => {
  const fake = fakeVscode();
  const reviews = createReviewDocuments(fake.api);
  await reviews.openDiff({ path: "/repo/src/app.ts", original: "old", proposed: "new", title: "Rename" });
  const [command, left, right, title, options] = fake.calls[0];
  assert.equal(command, "vscode.diff");
  assert.equal(left.scheme, REVIEW_SCHEME);
  assert.equal(left.path, "/r1/original/app.ts");
  assert.equal(right.path, "/r1/proposed/app.ts");
  assert.equal(title, "Rename");
  assert.equal(options.preview, true);
  assert.equal(fake.provider().provideTextDocumentContent(left), "old");
  assert.equal(fake.provider().provideTextDocumentContent(right), "new");
  assert.match(fake.provider().provideTextDocumentContent({ path: "/r99/original/x" }), /no longer available/);
  reviews.dispose();
  assert.deepEqual(fake.calls.at(-1), ["dispose"]);
});

test("a permission preview opens one diff, several as a changes view, or reports it cannot", async () => {
  const fake = fakeVscode();
  const reviews = createReviewDocuments(fake.api);
  assert.equal(await reviews.openPreview(CREATE, "SeekForge: write_file"), true);
  assert.equal(fake.calls[0][0], "vscode.diff");
  assert.equal(fake.calls[0][3], "SeekForge: write_file (new file)");

  assert.equal(await reviews.openPreview(`${EDIT}\n${CREATE}`, "SeekForge: lsp_rename"), true);
  const [command, title, entries] = fake.calls[1];
  assert.equal(command, "vscode.changes");
  assert.equal(title, "SeekForge: lsp_rename");
  assert.equal(entries.length, 2);
  assert.equal(fake.provider().provideTextDocumentContent(entries[0][1]), "a\n-- sql comment\nb\nc");

  assert.equal(await reviews.openPreview("not a diff", "x"), false);
  assert.equal(fake.calls.length, 2);
});
