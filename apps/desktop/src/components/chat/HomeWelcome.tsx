import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { View } from "../../store";
import type { AgentInfo, SessionMeta, Skill } from "../../types";
import {
  IconAgents,
  IconArrowRight,
  IconChat,
  IconDiff,
  IconSessions,
  IconSkills,
  IconSparkle,
  LogoMark,
} from "../ui/icons";

type QuickAction = { key: string; taskKey: string; Icon: ComponentType<{ size?: number; className?: string }> };

const QUICK_ACTIONS: QuickAction[] = [
  { key: "chat.home.action.explore", taskKey: "chat.home.action.exploreTask", Icon: IconSkills },
  { key: "chat.home.action.fixTests", taskKey: "chat.home.action.fixTestsTask", Icon: IconSparkle },
  { key: "chat.home.action.viewDiff", taskKey: "chat.home.action.viewDiffTask", Icon: IconDiff },
  { key: "chat.home.action.runTests", taskKey: "chat.home.action.runTestsTask", Icon: IconChat },
];

type Props = {
  /** Populate the composer with a task starter (does not send). */
  onQuickAction: (task: string) => void;
  /** Jump to another view (recent-session / skill / agent "view all"). */
  onNavigate: (view: View) => void;
  /** Re-fetch trigger: the active workspace id. */
  workspaceId: string;
};

/**
 * The default chat landing — a Codex-style workbench home shown when a tab has
 * no messages yet: a welcome card, quick-action starters, and lightweight
 * recents (sessions / skills / agents) pulled live from the server.
 */
export function HomeWelcome({ onQuickAction, onNavigate, workspaceId }: Props) {
  const t = useT();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    let alive = true;
    api.sessions(workspaceId).then((r) => alive && setSessions(r)).catch(() => {});
    api.skills(workspaceId).then((r) => alive && setSkills(r)).catch(() => {});
    api.agents(workspaceId).then((r) => alive && setAgents(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const recentSessions = [...sessions]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 4);
  const topSkills = skills.filter((s) => s.enabled).slice(0, 4);
  const topAgents = agents.slice(0, 4);

  return (
    <div className="sf-cq mx-auto w-full max-w-3xl space-y-5 py-6">
      {/* Welcome banner */}
      <div className="relative overflow-hidden rounded-2xl border border-subtle bg-gradient-to-br from-accent-muted via-surface-raised to-surface-raised p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10">
            <LogoMark size={22} className="text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-primary">{t("chat.home.title")}</h2>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-secondary">{t("chat.home.desc")}</p>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <h3 className="mb-2 px-1 text-2xs font-medium uppercase tracking-wider text-tertiary">
          {t("chat.home.quickActions")}
        </h3>
        <div className="sf-home-grid-2 gap-3">
          {QUICK_ACTIONS.map(({ key, taskKey, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onQuickAction(t(taskKey))}
              className="focus-ring group flex items-center gap-3 rounded-xl border border-subtle bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-accent-muted/40"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
                <Icon size={16} />
              </span>
              <span className="flex-1 text-sm font-medium text-primary">{t(key)}</span>
              <IconArrowRight
                size={15}
                className="text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          ))}
        </div>
      </div>

      {/* Recents: three columns (collapse to one at narrow content widths) */}
      <div className="sf-home-grid-3 gap-3">
        <RecentColumn
          title={t("chat.home.recentSessions")}
          Icon={IconSessions}
          onViewAll={() => onNavigate("sessions")}
          viewAllLabel={t("chat.home.viewAll")}
          emptyLabel={t("chat.home.empty")}
          items={recentSessions.map((s) => ({
            id: s.id,
            primary: s.task,
            onClick: () => onNavigate("sessions"),
          }))}
        />
        <RecentColumn
          title={t("chat.home.skills")}
          Icon={IconSkills}
          onViewAll={() => onNavigate("skills")}
          viewAllLabel={t("chat.home.viewAll")}
          emptyLabel={t("chat.home.empty")}
          items={topSkills.map((s) => ({
            id: s.id,
            primary: s.name,
            onClick: () => onNavigate("skills"),
          }))}
        />
        <RecentColumn
          title={t("chat.home.agents")}
          Icon={IconAgents}
          onViewAll={() => onNavigate("agents")}
          viewAllLabel={t("chat.home.viewAll")}
          emptyLabel={t("chat.home.empty")}
          items={topAgents.map((a) => ({
            id: a.id,
            primary: a.name,
            onClick: () => onNavigate("agents"),
          }))}
        />
      </div>
    </div>
  );
}

type ColumnItem = { id: string; primary: string; onClick: () => void };

function RecentColumn({
  title,
  Icon,
  items,
  onViewAll,
  viewAllLabel,
  emptyLabel,
}: {
  title: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  items: ColumnItem[];
  onViewAll: () => void;
  viewAllLabel: string;
  emptyLabel: string;
}): ReactNode {
  return (
    <div className="flex flex-col rounded-xl border border-subtle bg-surface-raised p-3">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <Icon size={14} className="text-tertiary" />
        <span className="flex-1 text-xs font-medium text-secondary">{title}</span>
        <button
          type="button"
          onClick={onViewAll}
          className="focus-ring rounded text-2xs text-accent hover:text-accent-hover"
        >
          {viewAllLabel}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="px-1 py-2 text-xs text-tertiary">{emptyLabel}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={it.onClick}
                title={it.primary}
                className="focus-ring block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-surface-overlay"
              >
                {it.primary}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
