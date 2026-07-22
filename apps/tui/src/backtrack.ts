import type { ChatItem } from "./model.js";

/**
 * Conversation backtrack helpers (pure). A backtrack rewinds the transcript
 * to just before an earlier user turn so the user can edit and resend it.
 */

export type BacktrackTarget = {
  /** 0-based user-turn index aligned with truncateSessionAtUserTurn. */
  turn: number;
  /** The user message text (for refilling the composer). */
  text: string;
  /** Index of the corresponding "user" item in the items array. */
  itemIndex: number;
};

/**
 * User turns of the CURRENT session in transcript order, excluding turn 0
 * (the original task is not backtrackable). Newest LAST.
 *
 * Every "user" item is a turn: only real tasks become "user" items (slash
 * commands never dispatch a user item). Turn numbers therefore align with
 * truncateSessionAtUserTurn's all-user-messages indexing under the
 * assumption that one runTask appends exactly one user message to the
 * stored session.
 */
export function backtrackTargets(items: readonly ChatItem[]): BacktrackTarget[] {
  const targets: BacktrackTarget[] = [];
  let turn = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item?.kind !== "user") continue;
    turn += 1;
    if (turn === 0) continue; // the original task is never removable
    targets.push({ turn, text: item.text, itemIndex: i });
  }
  return targets;
}

/** Items to keep after backtracking to target: everything before itemIndex. */
export function truncateItems(items: readonly ChatItem[], target: BacktrackTarget): ChatItem[] {
  return items.slice(0, target.itemIndex);
}
