/**
 * Pure scrollback windowing: the transcript keeps every item, the viewport
 * shows a window of `size` items ending `offset` items above the bottom.
 * Keeping this arithmetic pure (and clamped) makes PageUp/PageDown and the
 * "N more below" indicators trivially testable without rendering.
 */

export type Window = {
  /** First visible index (inclusive). */
  start: number;
  /** One past the last visible index (exclusive). */
  end: number;
  /** Items hidden above the window. */
  hiddenAbove: number;
  /** Items hidden below the window (=== the effective offset). */
  hiddenBelow: number;
};

export function computeWindow(total: number, offset: number, size: number): Window {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeSize = Math.max(0, Math.floor(size));
  const maxOffset = Math.max(0, safeTotal - safeSize);
  const effective = Math.min(maxOffset, Math.max(0, Math.floor(offset)));
  const end = safeTotal - effective;
  const start = Math.max(0, end - safeSize);
  return { start, end, hiddenAbove: start, hiddenBelow: effective };
}
