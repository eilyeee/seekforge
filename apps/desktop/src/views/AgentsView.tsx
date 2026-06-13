import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconAgents, type BadgeTone } from "../components/ui";
import type { AgentInfo, AgentScope } from "../types";

const SCOPE_TONE: Record<AgentScope, BadgeTone> = {
  builtin: "neutral",
  global: "accent",
  project: "ok",
};

function ModeChip({ mode }: { mode: AgentInfo["mode"] }) {
  const t = useT();
  return <Badge tone={mode === "ask" ? "accent" : "warn"}>{mode === "ask" ? t("chat.mode.ask") : t("chat.mode.edit")}</Badge>;
}

function ScopeChip({ scope }: { scope: AgentScope }) {
  return <Badge tone={SCOPE_TONE[scope]}>{scope}</Badge>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-tertiary">{label}</div>
      <div className="font-mono text-xs text-secondary">{value}</div>
    </div>
  );
}

export function AgentsView() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [detail, setDetail] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-fetch when the active workspace changes (api scopes by ?ws=<active>).
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setAgents(null);
    setDetail(null);
    setError(null);
    api
      .agents()
      .then(setAgents)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const openAgent = (id: string) => {
    setError(null);
    api
      .agent(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)));
  };

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-subtle px-4 py-2">
          <Button size="sm" onClick={() => setDetail(null)}>
            {t("agents.backBtn")}
          </Button>
          <span className="text-sm font-semibold text-primary">{detail.name}</span>
          <span className="font-mono text-xs text-tertiary">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          <ModeChip mode={detail.mode} />
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-2xl space-y-4">
            <p className="text-sm text-secondary">{detail.description}</p>
            <Card className="grid grid-cols-2 gap-3">
              <Field label={t("agents.fieldModel")} value={detail.model ?? t("agents.defaultModel")} />
              <Field label={t("agents.fieldMaxTurns")} value={String(detail.maxTurns ?? 15)} />
              <Field label={t("agents.fieldTriggers")} value={detail.triggers.join(", ") || "—"} />
              <Field label={t("agents.fieldTools")} value={detail.tools?.join(", ") ?? t("agents.allTools")} />
              {detail.own && <Field label={t("agents.fieldOwns")} value={detail.own} />}
              {detail.doNotTouch && <Field label={t("agents.fieldDoNotTouch")} value={detail.doNotTouch} />}
              {detail.boundary && <Field label={t("agents.fieldBoundary")} value={detail.boundary} />}
            </Card>
            {detail.body && (
              <Card className="text-sm text-secondary">
                <Markdown source={detail.body} />
              </Card>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">{t("agents.title")}</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>
        )}
        {agents === null ? (
          <p className="text-tertiary">{t("agents.loading")}</p>
        ) : agents.length === 0 ? (
          <EmptyState
            icon={<IconAgents size={28} />}
            title={t("agents.emptyTitle")}
            description={t("agents.emptyDescription")}
          />
        ) : (
          <div className="max-w-3xl space-y-2">
            {agents.map((a) => (
              <Card
                key={a.id}
                flush
                onClick={() => openAgent(a.id)}
                className="cursor-pointer p-3 transition-colors hover:bg-surface-overlay"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-primary">{a.id}</span>
                  <ScopeChip scope={a.scope} />
                  <ModeChip mode={a.mode} />
                  {a.model && <span className="font-mono text-xs text-tertiary">{a.model}</span>}
                </div>
                <p className="mt-1.5 truncate text-xs text-secondary">{a.description}</p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
