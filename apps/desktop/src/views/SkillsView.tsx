import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconChevron,
  IconSkills,
  Input,
  type BadgeTone,
} from "../components/ui";
import type { Skill, SkillScope } from "../types";

const SCOPE_TONE: Record<SkillScope, BadgeTone> = {
  builtin: "neutral",
  global: "accent",
  project: "ok",
};

const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: "BUILTIN",
  global: "GLOBAL",
  project: "CUSTOM",
};

/** Stable per-skill icon accent so the list reads colorful but restrained. */
const ICON_TONES = [
  "bg-accent/10 text-accent",
  "bg-ok/15 text-ok",
  "bg-warn/15 text-warn",
  "bg-danger/15 text-danger",
] as const;

function iconTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ICON_TONES[h % ICON_TONES.length] ?? ICON_TONES[0];
}

function ScopeChip({ scope }: { scope: SkillScope }) {
  return <Badge tone={SCOPE_TONE[scope]}>{SCOPE_LABEL[scope]}</Badge>;
}

type Filter = "all" | SkillScope;

export function SkillsView() {
  const t = useT();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setSkills(null);
    setDetail(null);
    setError(null);
    setFilter("all");
    setQuery("");
    api
      .skills()
      .then(setSkills)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const openSkill = (id: string) => {
    setError(null);
    api
      .skill(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)));
  };

  const counts = useMemo(() => {
    const c = { all: 0, builtin: 0, global: 0, project: 0 };
    for (const s of skills ?? []) {
      c.all++;
      c[s.scope]++;
    }
    return c;
  }, [skills]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? []).filter((s) => {
      if (filter !== "all" && s.scope !== filter) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    });
  }, [skills, filter, query]);

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-subtle px-6 py-3">
          <Button size="sm" onClick={() => setDetail(null)}>
            {t("skills.backBtn")}
          </Button>
          <span className="font-mono text-sm font-medium text-primary">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          {!detail.enabled && <Badge tone="danger">{t("skills.disabled")}</Badge>}
        </header>
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-3xl">
            <Card className="p-6">
              <Markdown source={detail.content ?? t("skills.noContent")} />
            </Card>
          </div>
        </div>
      </div>
    );
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: t("skills.scopeAll"), count: counts.all },
    { key: "builtin", label: t("skills.scopeBuiltin"), count: counts.builtin },
    { key: "global", label: t("skills.scopeGlobal"), count: counts.global },
    { key: "project", label: t("skills.scopeCustom"), count: counts.project },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-subtle px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-primary">{t("skills.title")}</h1>
          <p className="mt-1 text-xs text-tertiary">{t("skills.subtitle")}</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-6 py-3">
        <div className="flex items-center gap-1">
          {tabs.map((tab) => {
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-accent-muted text-accent-hover"
                    : "text-secondary hover:bg-surface-overlay hover:text-primary"
                }`}
              >
                {tab.label}
                <span
                  className={`rounded px-1.5 text-2xs font-mono ${
                    active ? "bg-accent/15 text-accent-hover" : "bg-surface-overlay text-tertiary"
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative w-full max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary">
            <IconSkills size={14} />
          </span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className="pl-9 pr-12"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-subtle bg-surface px-1.5 py-0.5 font-mono text-2xs text-tertiary">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error && (
          <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>
        )}
        {skills === null ? (
          <p className="text-tertiary">{t("skills.loading")}</p>
        ) : skills.length === 0 ? (
          <EmptyState
            icon={<IconSkills size={28} />}
            title={t("skills.emptyTitle")}
            description={t("skills.emptyDescription")}
          />
        ) : visible.length === 0 ? (
          <EmptyState icon={<IconSkills size={28} />} title={t("skills.emptyTitle")} />
        ) : (
          <div className="space-y-2">
            {visible.map((skill) => (
              <Card
                key={skill.id}
                flush
                onClick={() => openSkill(skill.id)}
                className="group flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-strong hover:bg-surface-overlay"
              >
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-xl ${iconTone(skill.id)}`}
                >
                  <IconSkills size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-primary">
                      {skill.id}
                    </span>
                    {!skill.enabled && <Badge tone="danger">{t("skills.disabled")}</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-secondary">{skill.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ScopeChip scope={skill.scope} />
                  <IconChevron
                    size={16}
                    className="text-tertiary transition-colors group-hover:text-secondary"
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
