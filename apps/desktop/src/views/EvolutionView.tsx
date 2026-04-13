import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { transitionProposal, type EvolutionAction } from "../lib/evolution";
import type { EvolutionProposal, EvolutionProposalRisk, EvolutionProposalType } from "../types";

const TYPE_BADGE: Record<EvolutionProposalType, string> = {
  project_memory: "bg-sky-900 text-sky-200",
  agent_rule: "bg-violet-900 text-violet-200",
  skill: "bg-emerald-900 text-emerald-200",
};

const RISK_CHIP: Record<EvolutionProposalRisk, string> = {
  low: "bg-zinc-800 text-zinc-300",
  medium: "bg-amber-900 text-amber-200",
  high: "bg-red-900 text-red-200",
};

const STATUS_CHIP: Record<EvolutionProposal["status"], string> = {
  pending: "bg-zinc-800 text-zinc-300",
  accepted: "bg-sky-900 text-sky-200",
  applied: "bg-emerald-900 text-emerald-200",
  rejected: "bg-red-950 text-red-300",
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
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Evolution</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        {proposals === null ? (
          <p className="text-zinc-600">Loading…</p>
        ) : (
          <div className="max-w-3xl space-y-6">
            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">pending proposals</h2>
              {pending.length === 0 ? (
                <p className="text-sm text-zinc-600">No pending proposals.</p>
              ) : (
                <div className="space-y-3">
                  {pending.map((p) => (
                    <div key={p.id} className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${TYPE_BADGE[p.type]}`}>
                          {p.type}
                        </span>
                        <span className="text-sm font-semibold text-zinc-100">{p.title}</span>
                        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase ${RISK_CHIP[p.risk]}`}>
                          {p.risk} risk
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-zinc-400">{p.problem}</p>
                      <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-300">
                        {p.proposal.content}
                      </pre>
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "reject")}
                          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "accept")}
                          className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                          Accept
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">history</h2>
              {history.length === 0 ? (
                <p className="text-sm text-zinc-600">Nothing reviewed yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-xs"
                    >
                      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_CHIP[p.status]}`}>
                        {p.status}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${TYPE_BADGE[p.type]}`}>
                        {p.type}
                      </span>
                      <span className="text-zinc-300">{p.title}</span>
                      {p.status === "applied" && changedPaths[p.id] && (
                        <span className="font-mono text-[11px] text-emerald-400">→ {changedPaths[p.id]}</span>
                      )}
                      {p.status === "accepted" && (
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => void act(p.id, "apply")}
                          className="ml-auto rounded bg-sky-700 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
                        >
                          Apply
                        </button>
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
