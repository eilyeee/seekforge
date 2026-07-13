import { emptyEditor, type EditorState } from "./editor.js";

export type ComposerDrafts = Map<number, EditorState>;

export function saveComposerDraft(drafts: ComposerDrafts, tabId: number, editor: EditorState): void {
  drafts.set(tabId, editor);
}

export function composerDraftFor(drafts: ComposerDrafts, tabId: number): EditorState {
  return drafts.get(tabId) ?? emptyEditor();
}
