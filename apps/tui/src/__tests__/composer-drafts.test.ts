import { describe, expect, it } from "vitest";
import { composerDraftFor, saveComposerDraft } from "../composer-drafts.js";
import { setText } from "../editor.js";

describe("composer drafts", () => {
  it("keeps editor text and cursor independent per tab", () => {
    const drafts = new Map();
    saveComposerDraft(drafts, 1, { text: "first tab", cursor: 5 });
    saveComposerDraft(drafts, 2, setText("second tab"));

    expect(composerDraftFor(drafts, 1)).toEqual({ text: "first tab", cursor: 5 });
    expect(composerDraftFor(drafts, 2)).toEqual({ text: "second tab", cursor: 10 });
    expect(composerDraftFor(drafts, 3)).toEqual({ text: "", cursor: 0 });
  });
});
