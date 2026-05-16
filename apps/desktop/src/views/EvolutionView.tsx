import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { transitionProposal, type EvolutionAction } from "../lib/evolution";
import { Badge, Button, Card, EmptyState, IconEvolution, type BadgeTone } from "../components/ui";
import type { EvolutionProposal, EvolutionProposalRisk, EvolutionProposalType } from "../types";

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

export function EvolutionView() {
  const [proposals, setProposals] = useState<EvolutionProposal[] | null>(null);
  const [changedPaths, setChangedPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setProposals(null);
    setChangedPaths({});
    setError(null);
    api
      .evolution()
      .then(setProposals)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const act = async (id: string, action: EvolutionAction) => {
    if (!proposals || busyId) return;
    const prev = proposals;
    const optimistic = transitionProposal(prev, id, action);
    if (!optimistic) return;
    setProposals(optimistic);
    setBusyId(id);
    setError(null);
    try {
      if (action === "apply") {
        const { proposal, changedPath } = await api.evolutionApply(id);
        setChangedPaths((p) => ({ ...p, [id]: changedPath }));
        setProposals((cur) => (cur ?? optimistic).map((x) => (x.id === id ? proposal : x)));
      } else {
        const proposal = await api.evolutionAction(id, action);
        setProposals((cur) => (cur ?? optimistic).map((x) => (x.id === id ? proposal : x)));
      }
    } catch (e) {
      // Roll the optimistic transition back.
      setProposals(prev);
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const pending = (proposals ?? []).filter((p) => p.status === "pending");
  const history = (proposals ?? []).filter((p) => p.status !== "pending");

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">Evolution</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>
        )}
        {proposals === null ? (
          <p className="text-tertiary">Loading…</p>
        ) : proposals.length === 0 ? (
          <EmptyState
            icon={<IconEvolution size={28} />}
            title="No proposals"
            description="SeekForge surfaces self-improvement proposals here after sessions."
          />
        ) : (
          <div className="max-w-3xl space-y-6">
            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">pending proposals</h2>
              {pending.length === 0 ? (
                <p className="text-sm text-tertiary">No pending proposals.</p>
              ) : (
                <div className="space-y-3">
                  {pending.map((p) => (
                    <Card key={p.id} flush className="p-3">
                      <div className="flex items-center gap-2">
                        <Badge tone={TYPE_TONE[p.type]}>{p.type}</Badge>
                        <span className="text-sm font-semibold text-primary">{p.title}</span>
                        <Badge tone={RISK_TONE[p.risk]} className="ml-auto">
                          {p.risk} risk
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-secondary">{p.problem}</p>
                      <pre className="mt-2 overflow-x-auto rounded border border-subtle bg-surface p-2 font-mono text-xs text-secondary">
                        {p.proposal.content}
                      </pre>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "reject")}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "accept")}
                        >
                          Accept
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">history</h2>
              {history.length === 0 ? (
                <p className="text-sm text-tertiary">Nothing reviewed yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-3 py-1.5 text-xs"
                    >
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                      <Badge tone={TYPE_TONE[p.type]}>{p.type}</Badge>
                      <span className="text-secondary">{p.title}</span>
                      {p.status === "applied" && changedPaths[p.id] && (
                        <span className="font-mono text-[11px] text-accent">→ {changedPaths[p.id]}</span>
                      )}
                      {p.status === "accepted" && (
                        <Button
                          size="sm"
                          variant="primary"
                          className="ml-auto"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "apply")}
                        >
                          Apply
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
