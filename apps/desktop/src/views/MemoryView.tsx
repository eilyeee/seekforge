import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import type { MemoryCandidate, MemoryResponse } from "../types";

const TYPE_BADGE: Record<MemoryCandidate["type"], string> = {
  command: "bg-amber-900 text-amber-200",
  path: "bg-sky-900 text-sky-200",
  convention: "bg-purple-900 text-purple-200",
  tech: "bg-emerald-900 text-emerald-200",
  task_pattern: "bg-zinc-700 text-zinc-200",
};

export function MemoryView() {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setMemory(null);
    api
      .memory()
      .then(setMemory)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const act = (id: string, action: "approve" | "reject") => {
    if (!memory) return;
    const previous = memory;
    // Optimistic update; roll back on failure.
    setMemory({
      ...memory,
      candidates: memory.candidates.map((c) =>
        c.id === id ? { ...c, status: action === "approve" ? "approved" : "rejected" } : c,
      ),
    });
    api.memoryAction(id, action).catch((e: unknown) => {
      setError(String(e));
      setMemory(previous);
    });
  };

  const pending = memory?.candidates.filter((c) => c.status === "pending") ?? [];
  const resolved = memory?.candidates.filter((c) => c.status !== "pending") ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Memory</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        {memory === null ? (
          <p className="text-zinc-600">Loading…</p>
        ) : (
          <div className="space-y-6">
            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
                pending candidates ({pending.length})
              </h2>
              {pending.length === 0 ? (
                <p className="text-xs text-zinc-600">Nothing awaiting review.</p>
              ) : (
                <div className="space-y-2">
                  {pending.map((c) => (
                    <CandidateCard key={c.id} candidate={c} onAct={act} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">project.md</h2>
              {memory.projectMd ? (
                <div className="rounded border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                  <Markdown source={memory.projectMd} />
                </div>
              ) : (
                <p className="text-xs text-zinc-600">No project memory yet.</p>
              )}
            </section>

            {resolved.length > 0 && (
              <section>
                <h2 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">resolved</h2>
                <div className="space-y-2 opacity-60">
                  {resolved.map((c) => (
                    <CandidateCard key={c.id} candidate={c} onAct={act} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  onAct,
}: {
  candidate: MemoryCandidate;
  onAct: (id: string, action: "approve" | "reject") => void;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${TYPE_BADGE[candidate.type]}`}>
          [{candidate.type}]
        </span>
        <span className="font-mono text-[11px] text-zinc-500">
          confidence {(candidate.confidence * 100).toFixed(0)}%
        </span>
        {candidate.status !== "pending" && (
          <span
            className={`ml-auto text-[10px] uppercase ${
              candidate.status === "approved" ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {candidate.status}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-zinc-300">{candidate.content}</p>
      {candidate.status === "pending" && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => onAct(candidate.id, "approve")}
            className="rounded bg-emerald-800 px-3 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-700"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onAct(candidate.id, "reject")}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
