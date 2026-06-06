/**
 * Pure logic for the ⌘K command palette (components/CommandPalette.tsx): the
 * item registry shape and fuzzy filtering. No React, no fetch — unit tested in
 * palette.test.ts. Reuses the composer's fuzzyScore so ranking is consistent.
 */
import { fuzzyScore } from "./composer";
import type { View } from "../store";

/** One selectable palette entry: a view to open or a quick action to run. */
export type PaletteItem = {
  /** Stable id for keying. */
  id: string;
  /** Human label (already localized) shown as the primary text. */
  label: string;
  /** Section the item belongs to (drives the grouped headers). */
  section: "views" | "actions";
  /** Navigates to this view (mutually exclusive with `run`). */
  view?: View;
  /** Quick-action callback (mutually exclusive with `view`). */
  run?: () => void;
};

/**
 * Ranks the registry against the query (misses dropped, stable order on ties).
 * Matches the label AND the id's suffix (e.g. `view:git` → "git"), so a user can
 * type "git" to find "Open Source Control"; the best of the two scores wins. An
 * empty query returns everything in registry order.
 */
export function filterPaletteItems(query: string, items: readonly PaletteItem[]): PaletteItem[] {
  const q = query.trim();
  const scored: Array<{ item: PaletteItem; score: number; order: number }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as PaletteItem;
    const suffix = item.id.slice(item.id.lastIndexOf(":") + 1);
    const labelScore = fuzzyScore(q, item.label);
    const idScore = fuzzyScore(q, suffix);
    const score = Math.max(labelScore ?? Number.NEGATIVE_INFINITY, idScore ?? Number.NEGATIVE_INFINITY);
    if (score > Number.NEGATIVE_INFINITY) scored.push({ item, score, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.item);
}
