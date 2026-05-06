/**
 * Pure helpers for the backtrack ("rewind conversation to here") flow.
 *
 * Turn indexing caveat: the server numbers turns over ALL role:"user"
 * messages of messages.jsonl (the core's truncateSessionAtUserTurn
 * indexing), while the local transcript only shows the user bubbles it
 * rendered. The two normally coincide, but compaction or other history
 * rewrites can leave extra/fewer user messages in the file — so local
 * ordinals are aligned to server turns FROM THE END, where the recent
 * (still-backtrackable) turns of both views match.
 */
import type { ChatItem, ChatState } from "./events";

/**
 * Ordinal of a user chat item among ALL user items (0-based), plus the
 * total user-item count. Null when itemId is not a user item.
 */
export function userTurnOf(
  items: readonly ChatItem[],
  itemId: number,
): { turn: number; count: number } | null {
  let turn = -1;
  let count = 0;
  for (const item of items) {
    if (item.kind !== "user") continue;
    if (item.id === itemId) turn = count;
    count += 1;
  }
  return turn >= 0 ? { turn, count } : null;
}

/**
 * Maps a local user-bubble ordinal onto the server's turn index by aligning
 * the two sequences at their END (see module docs). With equal counts this
 * is the identity. The result may be <= 0 or out of range — callers must
 * check against the fetched turn list before POSTing.
 */
export function mapToServerTurn(localTurn: number, localCount: number, serverCount: number): number {
  return serverCount - (localCount - localTurn);
}

/**
 * Truncates the local transcript to just before the given user item: the
 * item itself and everything after are dropped — mirroring what the server
 * did to messages.jsonl. The session id is kept (still resumable).
 */
export function truncateChatAtItem(chat: ChatState, itemId: number): ChatState {
  const at = chat.items.findIndex((i) => i.id === itemId);
  if (at < 0) return chat;
  return { ...chat, items: chat.items.slice(0, at), running: false };
}
