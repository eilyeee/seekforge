import type { ChatItem } from "./events";

export type ChatTaskGroup = {
  key: string;
  user?: Extract<ChatItem, { kind: "user" }>;
  items: ChatItem[];
};

/** Groups a flat event transcript into user-owned task blocks without reordering. */
export function groupChatTasks(items: readonly ChatItem[]): ChatTaskGroup[] {
  const groups: ChatTaskGroup[] = [];
  let current: ChatTaskGroup | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      if (current) groups.push(current);
      current = { key: `task-${item.id}`, user: item, items: [] };
      continue;
    }
    if (!current) current = { key: "task-preamble", items: [] };
    current.items.push(item);
  }
  if (current) groups.push(current);
  return groups;
}

export function taskGroupStatus(
  group: ChatTaskGroup,
  fallback: "running" | "completed" | "failed" = "running",
): "running" | "completed" | "failed" {
  if (group.items.some((item) => item.kind === "failed")) return "failed";
  if (group.items.some((item) => item.kind === "report")) return "completed";
  return fallback;
}
