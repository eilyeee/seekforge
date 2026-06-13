import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Card, EmptyState, IconMemory, type BadgeTone } from "../components/ui";
import type { MemoryCandidate, MemoryResponse } from "../types";

const TYPE_TONE: Record<MemoryCandidate["type"], BadgeTone> = {
  command: "warn",
  path: "accent",
  convention: "accent",
  tech: "ok",
  task_pattern: "neutral",
};

export function MemoryView() {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setMemory(null);
    setError(null);
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
  const isEmpty =
    memory !== null && memory.candidates.length === 0 && !memory.projectMd;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">Memory</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {memory === null ? (
          !error && <p className="text-tertiary">Loading…</p>
        ) : isEmpty ? (
          <EmptyState
            icon={<IconMemory size={28} />}
            title="No memory yet"
            description="Approved facts and project memory will collect here as you work."
          />
        ) : (
          <div className="space-y-6">
            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">
                pending candidates ({pending.length})
              </h2>
              {pending.length === 0 ? (
                <p className="text-xs text-tertiary">Nothing awaiting review.</p>
              ) : (
                <div className="space-y-2">
                  {pending.map((c) => (
                    <CandidateCard key={c.id} candidate={c} onAct={act} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">project.md</h2>
              {memory.projectMd ? (
                <Card className="bg-surface-raised/40 px-4 py-3">
                  <Markdown source={memory.projectMd} />
                </Card>
              ) : (
                <p className="text-xs text-tertiary">No project memory yet.</p>
              )}
            </section>

            {resolved.length > 0 && (
              <section>
                <h2 className="mb-2 text-[10px] uppercase tracking-wider text-tertiary">resolved</h2>
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
    <Card flush className="bg-surface-raised/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge tone={TYPE_TONE[candidate.type]}>[{candidate.type}]</Badge>
        <span className="font-mono text-[11px] text-tertiary">
          confidence {(candidate.confidence * 100).toFixed(0)}%
        </span>
        {candidate.status !== "pending" && (
          <span
            className={`ml-auto text-[10px] uppercase ${
              candidate.status === "approved" ? "text-ok" : "text-danger"
            }`}
          >
            {candidate.status}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-secondary">{candidate.content}</p>
      {candidate.status === "pending" && (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => onAct(candidate.id, "approve")}>
            Approve
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAct(candidate.id, "reject")}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}
