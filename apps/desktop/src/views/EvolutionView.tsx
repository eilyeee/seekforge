import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { transitionProposal, type EvolutionAction } from "../lib/evolution";
import { useT } from "../lib/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconArrowRight,
  IconCornerDownRight,
  IconEvolution,
  IconSparkle,
  type BadgeTone,
} from "../components/ui";
import type { EvolutionProposal, EvolutionProposalRisk, EvolutionProposalType } from "../types";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

const TYPE_TONE: Record<EvolutionProposalType, BadgeTone> = {
  project_memory: "accent",
  agent_rule: "accent",
  skill: "ok",
};

const RISK_TONE: Record<EvolutionProposalRisk, BadgeTone> = {
  low: "neutral",
  medium: "warn",
  high: "danger",
};

const STATUS_TONE: Record<EvolutionProposal["status"], BadgeTone> = {
  pending: "neutral",
  accepted: "accent",
  applied: "ok",
  rejected: "danger",
};

/** Compact stat tile used for the quality-trend row. */
function MetricCard({
  icon,
  label,
  value,
  suffix,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-tertiary">
        <span className="text-accent">{icon}</span>
        <span className="text-2xs uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums text-primary">{value}</span>
        {suffix && <span className="text-xs text-tertiary">{suffix}</span>}
      </div>
    </Card>
  );
}

export function EvolutionView() {
  const t = useT();
  const [proposals, setProposals] = useState<EvolutionProposal[] | null>(null);
  const [changedPaths, setChangedPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  useEffect(() => {
    const request = requests.beginLatest(ws);
    if (!request) return;
    setProposals(null);
    setChangedPaths({});
    setError(null);
    setBusyId(null);
    api
      .evolution()
      .then((nextProposals) => {
        if (requests.isCurrent(request)) setProposals(nextProposals);
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(request)) setError(String(e));
      });
  }, [requests]);

  const act = async (id: string, action: EvolutionAction) => {
    if (!proposals || busyId) return;
    const operation = requests.capture(ws);
    if (!operation) return;
    const prev = proposals;
    const optimistic = transitionProposal(prev, id, action);
    if (!optimistic) return;
    setProposals(optimistic);
    setBusyId(id);
    setError(null);
    try {
      if (action === "apply") {
        const { proposal, changedPath } = await api.evolutionApply(id);
        if (!requests.isCurrent(operation)) return;
        setChangedPaths((p) => ({ ...p, [id]: changedPath }));
        setProposals((cur) => (cur ?? optimistic).map((x) => (x.id === id ? proposal : x)));
      } else {
        const proposal = await api.evolutionAction(id, action);
        if (!requests.isCurrent(operation)) return;
        setProposals((cur) => (cur ?? optimistic).map((x) => (x.id === id ? proposal : x)));
      }
    } catch (e) {
      if (!requests.isCurrent(operation)) return;
      // Roll the optimistic transition back.
      setProposals(prev);
      setError(String(e));
    } finally {
      if (requests.isCurrent(operation)) setBusyId(null);
    }
  };

  const all = proposals ?? [];
  const pending = all.filter((p) => p.status === "pending");
  const history = all.filter((p) => p.status !== "pending");
  const applied = all.filter((p) => p.status === "applied");
  const accepted = all.filter((p) => p.status === "accepted");
  const reviewed = all.filter((p) => p.status !== "pending");
  const adoptionRate = reviewed.length
    ? Math.round(((accepted.length + applied.length) / reviewed.length) * 100)
    : 0;

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-start gap-3 border-b border-subtle px-6 py-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent">
          <IconEvolution size={18} />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-primary">{t("evolution.title")}</h1>
          <p className="mt-0.5 text-xs text-secondary">{t("evolution.emptyDescription")}</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Card className="mb-4 border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</Card>
        )}
        {proposals === null ? (
          <p className="text-tertiary">{t("evolution.loading")}</p>
        ) : proposals.length === 0 ? (
          <EmptyState
            icon={<IconEvolution size={28} />}
            title={t("evolution.emptyTitle")}
            description={t("evolution.emptyDescription")}
          />
        ) : (
          <div className="space-y-7">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard
                icon={<IconSparkle size={14} />}
                label={t("evolution.pendingSection")}
                value={pending.length}
              />
              <MetricCard
                icon={<IconCornerDownRight size={14} />}
                label={t("evolution.acceptBtn")}
                value={accepted.length}
              />
              <MetricCard
                icon={<IconArrowRight size={14} />}
                label={t("evolution.applyBtn")}
                value={applied.length}
              />
              <MetricCard
                icon={<IconEvolution size={14} />}
                label={t("evolution.historySection")}
                value={adoptionRate}
                suffix="%"
              />
            </section>

            <section>
              <h2 className="mb-3 text-2xs uppercase tracking-wider text-tertiary">{t("evolution.pendingSection")}</h2>
              {pending.length === 0 ? (
                <p className="text-sm text-tertiary">{t("evolution.pendingEmpty")}</p>
              ) : (
                <div className="space-y-3">
                  {pending.map((p) => (
                    <Card key={p.id} className="p-5">
                      <div className="flex items-center gap-2">
                        <Badge tone={TYPE_TONE[p.type]}>{p.type}</Badge>
                        <span className="text-sm font-semibold text-primary">{p.title}</span>
                        <Badge tone={RISK_TONE[p.risk]} className="ml-auto">
                          {t("evolution.riskLabel", { level: p.risk })}
                        </Badge>
                      </div>
                      <p className="mt-3 text-xs leading-relaxed text-secondary">{p.problem}</p>
                      <pre className="mt-3 overflow-x-auto rounded-lg border border-subtle bg-surface p-3 font-mono text-xs leading-relaxed text-secondary">
                        {p.proposal.content}
                      </pre>
                      <div className="mt-4 flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "reject")}
                        >
                          {t("evolution.rejectBtn")}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "accept")}
                        >
                          {t("evolution.acceptBtn")}
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-2xs uppercase tracking-wider text-tertiary">{t("evolution.historySection")}</h2>
              {history.length === 0 ? (
                <p className="text-sm text-tertiary">{t("evolution.historyEmpty")}</p>
              ) : (
                <Card flush className="divide-y divide-subtle overflow-hidden">
                  {history.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs"
                    >
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                      <Badge tone={TYPE_TONE[p.type]}>{p.type}</Badge>
                      <span className="text-secondary">{p.title}</span>
                      {p.status === "applied" && changedPaths[p.id] && (
                        <span className="inline-flex items-center gap-0.5 font-mono text-2xs text-accent"><IconArrowRight size={10} />{changedPaths[p.id]}</span>
                      )}
                      {p.status === "accepted" && (
                        <Button
                          size="sm"
                          variant="primary"
                          className="ml-auto"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "apply")}
                        >
                          {t("evolution.applyBtn")}
                        </Button>
                      )}
                    </div>
                  ))}
                </Card>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
