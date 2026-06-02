import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  IconMemory,
  IconSparkle,
  IconCornerDownRight,
  type BadgeTone,
} from "../components/ui";
import type { MemoryCandidate, MemoryCandidateType, MemoryFact, MemoryResponse } from "../types";

const TYPE_TONE: Record<MemoryCandidate["type"], BadgeTone> = {
  command: "warn",
  path: "accent",
  convention: "accent",
  tech: "ok",
  task_pattern: "neutral",
};

const FACT_TYPES: MemoryCandidateType[] = ["convention", "command", "path", "tech", "task_pattern"];

/** A fact unused for this long is flagged as stale (subtly). */
const STALE_MS = 60 * 24 * 60 * 60 * 1000; // ~60 days

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Coarse relative-age label ("just now" / "Nd ago" / "Nmo ago"). */
function relativeAge(t: T, iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return t("memory.factAgeJustNow");
  if (days < 30) return t("memory.factAgeDays", { count: days });
  return t("memory.factAgeMonths", { count: Math.floor(days / 30) });
}

export function MemoryView() {
  const t = useT();
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

  const refresh = () =>
    api
      .memory()
      .then(setMemory)
      .catch((e: unknown) => setError(String(e)));

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

  const deleteFact = (fact: MemoryFact) => {
    if (!memory) return;
    const previous = memory;
    // Optimistic removal; reload (re-numbers indexes) on success, roll back on failure.
    setMemory({ ...memory, facts: memory.facts.filter((f) => f.index !== fact.index) });
    api
      .memoryDeleteFact({ index: fact.index })
      .then(refresh)
      .catch((e: unknown) => {
        setError(String(e));
        setMemory(previous);
      });
  };

  const addFact = (content: string, type: MemoryCandidateType): Promise<void> =>
    api.memoryAddFact(content, type).then(refresh);

  const pending = memory?.candidates.filter((c) => c.status === "pending") ?? [];
  const resolved = memory?.candidates.filter((c) => c.status !== "pending") ?? [];
  const facts = memory?.facts ?? [];
  const isEmpty =
    memory !== null && memory.candidates.length === 0 && facts.length === 0 && !memory.projectMd;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-subtle px-6 py-4">
        <h1 className="text-lg font-semibold text-primary">{t("memory.title")}</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tertiary">{t("memory.description")}</p>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {memory === null ? (
          !error && <p className="text-sm text-tertiary">{t("memory.loading")}</p>
        ) : isEmpty ? (
          <EmptyState
            icon={<IconMemory size={28} />}
            title={t("memory.emptyTitle")}
            description={t("memory.emptyDescription")}
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Main column: pending candidates + resolved */}
            <div className="space-y-6 lg:col-span-2">
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-2xs uppercase tracking-wider text-tertiary">
                    {t("memory.pendingSection", { count: pending.length })}
                  </h2>
                  <span className="h-px flex-1 border-t border-subtle" />
                </div>
                {pending.length === 0 ? (
                  <p className="text-xs text-tertiary">{t("memory.pendingEmpty")}</p>
                ) : (
                  <div className="space-y-3">
                    {pending.map((c) => (
                      <CandidateCard key={c.id} candidate={c} onAct={act} />
                    ))}
                  </div>
                )}
              </section>

              {resolved.length > 0 && (
                <section>
                  <div className="mb-3 flex items-center gap-2">
                    <h2 className="text-2xs uppercase tracking-wider text-tertiary">
                      {t("memory.resolvedSection")}
                    </h2>
                    <span className="h-px flex-1 border-t border-subtle" />
                  </div>
                  <div className="space-y-3 opacity-60">
                    {resolved.map((c) => (
                      <CandidateCard key={c.id} candidate={c} onAct={act} />
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Side column: approved facts (lifecycle + management) + project.md */}
            <aside className="space-y-6 lg:col-span-1">
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <IconCornerDownRight size={13} className="text-tertiary" />
                  <h2 className="text-2xs uppercase tracking-wider text-tertiary">
                    {t("memory.factsSection", { count: facts.length })}
                  </h2>
                </div>
                <Card className="border-accent/30 bg-accent/[0.04] p-4">
                  {facts.length === 0 ? (
                    <p className="text-xs text-tertiary">{t("memory.factsEmpty")}</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {facts.map((fact) => (
                        <FactRow key={fact.index} fact={fact} onDelete={deleteFact} />
                      ))}
                    </ul>
                  )}
                  <AddFactForm onAdd={addFact} />
                </Card>
              </section>

              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-2xs uppercase tracking-wider text-tertiary">
                    {t("memory.projectMdSection")}
                  </h2>
                </div>
                {memory.projectMd ? (
                  <Card className="border-accent/30 bg-accent/[0.04] p-5">
                    <div className="mb-3 flex items-center gap-2 text-accent-hover">
                      <IconSparkle size={14} />
                      <span className="font-mono text-2xs uppercase tracking-wide">
                        {t("memory.projectMdSection")}
                      </span>
                    </div>
                    <div className="text-sm leading-relaxed text-secondary">
                      <Markdown source={memory.projectMd} />
                    </div>
                  </Card>
                ) : (
                  <Card className="border-dashed bg-surface-raised/40 p-5 text-xs text-tertiary">
                    {t("memory.projectMdEmpty")}
                  </Card>
                )}
              </section>
            </aside>
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
  const t = useT();
  const pct = (candidate.confidence * 100).toFixed(0);
  return (
    <Card className="p-4 transition-colors hover:border-strong">
      <div className="flex items-center gap-2">
        <Badge tone={TYPE_TONE[candidate.type]}>[{candidate.type}]</Badge>
        <span className="font-mono text-2xs text-tertiary">
          {t("memory.confidence", { pct })}
        </span>
        {candidate.status !== "pending" && (
          <span
            className={`ml-auto font-mono text-2xs uppercase tracking-wide ${
              candidate.status === "approved" ? "text-ok" : "text-danger"
            }`}
          >
            {candidate.status}
          </span>
        )}
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-secondary">{candidate.content}</p>
      {candidate.status === "pending" && (
        <div className="mt-3 flex gap-2 border-t border-subtle pt-3">
          <Button variant="primary" size="sm" onClick={() => onAct(candidate.id, "approve")}>
            {t("memory.approveBtn")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAct(candidate.id, "reject")}>
            {t("memory.rejectBtn")}
          </Button>
        </div>
      )}
    </Card>
  );
}

function FactRow({ fact, onDelete }: { fact: MemoryFact; onDelete: (fact: MemoryFact) => void }) {
  const t = useT();
  const neverUsed = fact.uses === 0;
  const lastUsed = fact.lastUsedAt ? new Date(fact.lastUsedAt).getTime() : null;
  const stale = !neverUsed && lastUsed !== null && Date.now() - lastUsed > STALE_MS;
  const usage = fact.addedAt
    ? t("memory.factUsage", { count: fact.uses, age: relativeAge(t, fact.addedAt) })
    : t("memory.factUsageNoAdded", { count: fact.uses });

  return (
    <li className="group flex items-start gap-2 border-b border-subtle/60 pb-2.5 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {fact.type && (
            <Badge tone={TYPE_TONE[fact.type]} className="shrink-0">
              [{fact.type}]
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-secondary">{fact.content}</p>
        <p className="mt-1 font-mono text-2xs text-tertiary">
          <span>{usage}</span>
          {neverUsed && <span className="ml-1.5 text-warn">· {t("memory.factNeverUsed")}</span>}
          {stale && <span className="ml-1.5 text-warn">· {t("memory.factStale")}</span>}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("memory.factDeleteTitle")}
        title={t("memory.factDeleteTitle")}
        className="shrink-0 px-1.5 py-0.5 text-tertiary opacity-0 hover:text-danger group-hover:opacity-100"
        onClick={() => onDelete(fact)}
      >
        ✕
      </Button>
    </li>
  );
}

function AddFactForm({
  onAdd,
}: {
  onAdd: (content: string, type: MemoryCandidateType) => Promise<void>;
}) {
  const t = useT();
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryCandidateType>("convention");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = content.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    onAdd(trimmed, type)
      .then(() => setContent(""))
      .catch(() => setError(t("memory.addFactError")))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 border-t border-subtle pt-3">
      <p className="mb-2 text-2xs uppercase tracking-wider text-tertiary">{t("memory.addFactTitle")}</p>
      <Input
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("memory.addFactPlaceholder")}
        disabled={busy}
      />
      <div className="mt-2 flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MemoryCandidateType)}
          disabled={busy}
          className="rounded-lg border border-strong bg-surface px-2 py-1.5 text-xs text-primary focus:border-accent/70 focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {FACT_TYPES.map((ft) => (
            <option key={ft} value={ft}>
              {ft}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={busy || content.trim() === ""}
          className="ml-auto"
        >
          {t("memory.addFactBtn")}
        </Button>
      </div>
      {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
    </div>
  );
}
