import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconSkills, type BadgeTone } from "../components/ui";
import type { Skill, SkillScope } from "../types";

const SCOPE_TONE: Record<SkillScope, BadgeTone> = {
  builtin: "neutral",
  global: "accent",
  project: "ok",
};

function ScopeChip({ scope }: { scope: SkillScope }) {
  return <Badge tone={SCOPE_TONE[scope]}>{scope}</Badge>;
}

export function SkillsView() {
  const t = useT();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setSkills(null);
    setDetail(null);
    setError(null);
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

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-subtle px-4 py-2">
          <Button size="sm" onClick={() => setDetail(null)}>
            {t("skills.backBtn")}
          </Button>
          <span className="font-mono text-xs text-secondary">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          {!detail.enabled && <Badge tone="danger">{t("skills.disabled")}</Badge>}
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <Markdown source={detail.content ?? t("skills.noContent")} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">{t("skills.title")}</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
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
        ) : (
          <div className="max-w-3xl space-y-2">
            {skills.map((skill) => (
              <Card
                key={skill.id}
                flush
                onClick={() => openSkill(skill.id)}
                className="cursor-pointer p-3 transition-colors hover:bg-surface-overlay"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-primary">{skill.id}</span>
                  <ScopeChip scope={skill.scope} />
                  {skill.scope === "builtin" && <Badge>builtin</Badge>}
                  {!skill.enabled && <Badge tone="danger">disabled</Badge>}
                </div>
                <p className="mt-1.5 text-xs text-secondary">{skill.description}</p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
