/** Distance from the transcript end that still counts as following live output. */
export const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 96;

export type TranscriptScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Keep following only while the reader is effectively at the transcript end.
 * A malformed browser measurement fails closed: never yank the reader away
 * from the place they deliberately opened.
 */
export function isNearTranscriptEnd(
  { scrollTop, scrollHeight, clientHeight }: TranscriptScrollMetrics,
  threshold = TRANSCRIPT_FOLLOW_THRESHOLD_PX,
): boolean {
  if (![scrollTop, scrollHeight, clientHeight, threshold].every(Number.isFinite)) return false;
  if (threshold < 0 || scrollTop < 0 || scrollHeight < 0 || clientHeight < 0) return false;
  return scrollHeight - clientHeight - scrollTop <= threshold;
}
