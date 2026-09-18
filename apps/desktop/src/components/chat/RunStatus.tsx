import { useT } from "../../lib/i18n";
import type { ChatItem } from "../../lib/events";
import { IconSparkle, IconThinking } from "../ui";

export type LiveRunActivity =
  | { kind: "tool"; name: string }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "subagent"; agentId: string }
  | { kind: "team" }
  | { kind: "plan"; step: string }
  | { kind: "waiting" };

/** Select the most specific current activity without relying on event wording. */
export function liveRunActivity(items: readonly ChatItem[]): LiveRunActivity {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "tool" && item.status === "running") return { kind: "tool", name: item.name };
    if (item.kind === "thinking" && item.streaming) return { kind: "thinking" };
    if (item.kind === "assistant" && item.streaming) return { kind: "writing" };
    if (item.kind === "subagent" && item.status === "running") return { kind: "subagent", agentId: item.agentId };
    if (item.kind === "team" && item.status === "running") return { kind: "team" };
    if (item.kind === "plan") {
      const active = item.items.find((step) => step.status === "in_progress");
      if (active) return { kind: "plan", step: active.activeForm ?? active.step };
    }
  }
  return { kind: "waiting" };
}

function activityText(activity: LiveRunActivity, t: ReturnType<typeof useT>): string {
  if (activity.kind === "tool") return t("chat.runStatus.tool", { tool: activity.name });
  if (activity.kind === "thinking") return t("chat.runStatus.thinking");
  if (activity.kind === "writing") return t("chat.runStatus.writing");
  if (activity.kind === "subagent") return t("chat.runStatus.subagent", { agent: activity.agentId });
  if (activity.kind === "team") return t("chat.runStatus.team");
  if (activity.kind === "plan") return t("chat.runStatus.plan", { step: activity.step });
  return t("chat.runStatus.waiting");
}

/** A compact, stable activity rail for a run that is still in progress. */
export function RunStatus({ items }: { items: readonly ChatItem[] }) {
  const t = useT();
  const activity = liveRunActivity(items);
  const completedActions = items.filter((item) => item.kind === "tool" && item.status !== "running").length;

  return (
    <div
      className="flex min-w-0 items-center gap-2 border-b border-accent/20 bg-accent-muted/35 px-4 py-2 text-xs"
      role="status"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
        {activity.kind === "thinking" ? (
          <IconThinking size={13} />
        ) : (
          <IconSparkle size={13} className="animate-pulse" />
        )}
      </span>
      <span className="shrink-0 font-medium text-primary">{t("chat.runStatus.working")}</span>
      <span className="min-w-0 truncate text-secondary">{activityText(activity, t)}</span>
      {completedActions > 0 && (
        <span className="ml-auto hidden shrink-0 text-tertiary sm:inline">
          {t("chat.runStatus.actions", { count: completedActions })}
        </span>
      )}
      <span className="hidden shrink-0 text-tertiary lg:inline">{t("chat.runStatus.steerHint")}</span>
    </div>
  );
}
