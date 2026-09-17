const path = require("node:path");

/** URI scheme of the read-only documents the native diff editor compares. */
const REVIEW_SCHEME = "seekforge-review";
/** Reviews kept addressable; an older diff tab re-renders as "no longer available". */
const MAX_REVIEWS = 64;
const SIDES = ["original", "proposed"];
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const TRUNCATED_RE = /^@@ … (\d+) more lines truncated @@$/;

/**
 * Rebuilds both sides of each file in a unified diff. Core renders an edit
 * preview as one whole-file hunk per file (context lines included), so the two
 * sides are the full before/after text unless the preview hit its line cap —
 * then both sides end with a marker saying so rather than passing a partial
 * file off as the whole thing.
 *
 * Hunk bodies are consumed by the counts in their `@@` header, so a content
 * line that happens to begin with `--- ` is never mistaken for a new file.
 */
function diffSides(diff) {
  const lines = String(diff ?? "").split("\n");
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i].startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && HUNK_RE.test(lines[i + 2] ?? ""))) {
      i += 1;
      continue;
    }
    const target = lines[i + 1].slice(4).trim();
    const file = {
      path: target.replace(/^b\//, ""),
      created: /^@@ -0,0 /.test(lines[i + 2]),
      original: [],
      proposed: [],
      truncated: 0,
    };
    i += 2;
    let hunks = 0;
    while (i < lines.length) {
      const hunk = HUNK_RE.exec(lines[i]);
      if (!hunk) break;
      if (hunks > 0) {
        // Only core's single-hunk previews are whole files; mark any gap.
        file.original.push("…");
        file.proposed.push("…");
      }
      hunks += 1;
      let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      i += 1;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const line = lines[i];
        const truncated = TRUNCATED_RE.exec(line);
        if (truncated) {
          file.truncated = Number(truncated[1]);
          i += 1;
          break;
        }
        const body = line.slice(1);
        if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
          file.original.push(body);
          file.proposed.push(body);
          oldLeft -= 1;
          newLeft -= 1;
        } else if (line.startsWith("-") && oldLeft > 0) {
          file.original.push(body);
          oldLeft -= 1;
        } else if (line.startsWith("+") && newLeft > 0) {
          file.proposed.push(body);
          newLeft -= 1;
        } else {
          break;
        }
        i += 1;
      }
      if (file.truncated) break;
    }
    const note = file.truncated
      ? [`… the preview stopped here; ${file.truncated} more diff line(s) were not included`]
      : [];
    files.push({
      path: file.path,
      created: file.created,
      truncated: file.truncated > 0,
      original: [...file.original, ...note].join("\n"),
      proposed: [...file.proposed, ...note].join("\n"),
    });
  }
  return files;
}

/**
 * Review contents by id. Documents are fetched lazily by the editor, possibly
 * long after the request, so entries outlive the prompt but are bounded: the
 * oldest review is evicted first.
 */
class ReviewStore {
  constructor(max = MAX_REVIEWS) {
    this.max = max;
    this.entries = new Map();
    this.seq = 0;
  }

  add(original, proposed) {
    this.seq += 1;
    const id = `r${this.seq}`;
    this.entries.set(id, { original: String(original), proposed: String(proposed) });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    return id;
  }

  get(id, side) {
    const entry = this.entries.get(id);
    return entry && SIDES.includes(side) ? entry[side] : undefined;
  }
}

/** `/<id>/<side>/<basename>` — the basename keeps the editor's language detection and tab title. */
function reviewPath(id, side, filePath) {
  const name = path.basename(String(filePath).replaceAll("\\", "/")) || "file";
  return `/${id}/${side}/${name}`;
}

function parseReviewPath(uriPath) {
  const match = /^\/(r\d+)\/(original|proposed)\//.exec(uriPath);
  return match ? { id: match[1], side: match[2] } : undefined;
}

/**
 * Registers the read-only provider and returns the openers. Documents served by
 * a content provider are read-only in the editor, so a reviewer cannot mistake
 * the proposed side for the real file and edit it.
 */
function createReviewDocuments(vscode) {
  const store = new ReviewStore();
  const registration = vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
    provideTextDocumentContent(uri) {
      const ref = parseReviewPath(uri.path);
      const text = ref ? store.get(ref.id, ref.side) : undefined;
      return text ?? "This SeekForge review is no longer available.";
    },
  });

  const uriFor = (id, side, filePath) =>
    vscode.Uri.from({ scheme: REVIEW_SCHEME, path: reviewPath(id, side, filePath) });

  async function openDiff({ path: filePath, original, proposed, title }) {
    const id = store.add(original, proposed);
    const name = path.basename(String(filePath));
    await vscode.commands.executeCommand(
      "vscode.diff",
      uriFor(id, "original", filePath),
      uriFor(id, "proposed", filePath),
      title || `${name} ↔ SeekForge proposal`,
      { preview: true, preserveFocus: false },
    );
  }

  /**
   * Opens a permission preview in the native diff editor: one file as a diff
   * tab, several as a multi-file changes view. Returns false when the text is
   * not a diff this parser understands, so the caller can fall back.
   */
  async function openPreview(diff, title) {
    const files = diffSides(diff);
    if (files.length === 0) return false;
    if (files.length === 1) {
      const [file] = files;
      await openDiff({
        path: file.path,
        original: file.original,
        proposed: file.proposed,
        title: `${title}${file.created ? " (new file)" : ""}${file.truncated ? " (truncated preview)" : ""}`,
      });
      return true;
    }
    const entries = files.map((file) => {
      const id = store.add(file.original, file.proposed);
      const right = uriFor(id, "proposed", file.path);
      return [right, uriFor(id, "original", file.path), right];
    });
    await vscode.commands.executeCommand("vscode.changes", title, entries);
    return true;
  }

  return { openDiff, openPreview, dispose: () => registration.dispose() };
}

module.exports = {
  MAX_REVIEWS,
  REVIEW_SCHEME,
  ReviewStore,
  createReviewDocuments,
  diffSides,
  parseReviewPath,
  reviewPath,
};
