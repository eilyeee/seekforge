/**
 * Large-paste placeholders. Big bracketed pastes would swamp the composer,
 * so the editor inserts a compact "[Pasted text #N (+L lines)]" token and
 * stashes the full text in a registry; expandPastes swaps the tokens back
 * in on submit. Pure and side-effect free.
 */

const MAX_LINES = 6;
const MAX_CHARS = 600;

export type PasteRegistry = {
  /** token → full pasted text */
  entries: Map<string, string>;
};

/** Fresh, empty registry (one per composer session). */
export function createPasteRegistry(): PasteRegistry {
  return { entries: new Map() };
}

/** True when a paste is big enough to placeholder: > 6 lines or > 600 chars. */
export function shouldPlaceholder(text: string): boolean {
  if (text.length > MAX_CHARS) return true;
  return text.split("\n").length > MAX_LINES;
}

/**
 * Stores the full text and returns its display token,
 * "[Pasted text #N (+L lines)]" — N is 1-based per registry, L the line count.
 */
export function registerPaste(reg: PasteRegistry, text: string): string {
  const n = reg.entries.size + 1;
  const lines = text.split("\n").length;
  const token = `[Pasted text #${n} (+${lines} lines)]`;
  reg.entries.set(token, text);
  return token;
}

/**
 * Replaces every registered token present in `text` with its full content.
 * Unknown tokens (or none) are left untouched.
 */
export function expandPastes(reg: PasteRegistry, text: string): string {
  let out = text;
  for (const [token, full] of reg.entries) {
    if (out.includes(token)) out = out.split(token).join(full);
  }
  return out;
}
