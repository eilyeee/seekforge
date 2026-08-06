import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import { memoryCompactOptions } from "../lib/memory-compact-ui";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  IconMemory,
  IconSparkle,
  IconCornerDownRight,
  type BadgeTone,
} from "../components/ui";
import type {
  CompactResult,
  MemoryCandidate,
  MemoryCandidateType,
  MemoryFact,
  MemoryResponse,
  MemoryStats,
  MemoryGovernanceReport,
} from "../types";
import { createSerialQueue, LatestRequest } from "./async-coordination";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

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

function sameFact(left: MemoryFact, right: MemoryFact): boolean {
  return (
    left.content === right.content &&
    left.type === right.type &&
    left.addedAt === right.addedAt &&
    left.uses === right.uses &&
    left.lastUsedAt === right.lastUsedAt
  );
}

export function MemoryView() {
  const t = useT();
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [governance, setGovernance] = useState<MemoryGovernanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where new/approved memory is written: this project or the user-level file
  // (~/.seekforge, shared across all projects). Governs add + approve.
  const [scope, setScope] = useState<"project" | "user">("project");
  const [filter, setFilter] = useState("");
  const ws = useStore((s) => s.activeWorkspaceId);
  const coordinator = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);
  const serverMemoryRef = useRef<{ workspaceId: string; value: MemoryResponse } | null>(null);
  const enqueueDelete = useRef(createSerialQueue()).current;

  const loadStats = (workspaceId: string) => {
    const operation = coordinator.capture(workspaceId);
    if (!operation) return Promise.resolve();
    return api
      .memoryStats(workspaceId)
      .then((value) => {
        if (coordinator.isCurrent(operation)) setStats(value);
      })
      .catch(() => {
        if (coordinator.isCurrent(operation)) setStats(null);
      });
  };

  const loadGovernance = (workspaceId: string) => {
    const operation = coordinator.capture(workspaceId);
    if (!operation) return Promise.resolve();
    return api
      .memoryGovernance(workspaceId)
      .then((value) => {
        if (coordinator.isCurrent(operation)) setGovernance(value);
      })
      .catch(() => {
        if (coordinator.isCurrent(operation)) setGovernance(null);
      });
  };

  useEffect(() => {
    const operation = coordinator.beginLatest(ws);
    if (!operation) return;
    serverMemoryRef.current = null;
    setMemory(null);
    setStats(null);
    setGovernance(null);
    setError(null);
    api
      .memory(ws)
      .then((value) => {
        if (!coordinator.isCurrent(operation)) return;
        serverMemoryRef.current = { workspaceId: ws, value };
        setMemory(value);
      })
      .catch((e: unknown) => {
        if (coordinator.isCurrent(operation)) setError(String(e));
      });
    void loadStats(ws);
    void loadGovernance(ws);
  }, [coordinator, ws]);

  const refresh = (workspaceId = ws) => {
    const operation = coordinator.beginLatest(workspaceId);
    if (!operation) return Promise.resolve();
    void loadStats(workspaceId);
    void loadGovernance(workspaceId);
    return api
      .memory(workspaceId)
      .then((value) => {
        if (!coordinator.isCurrent(operation)) return;
        serverMemoryRef.current = { workspaceId, value };
        setMemory(value);
      })
      .catch((e: unknown) => {
        if (coordinator.isCurrent(operation)) setError(String(e));
      });
  };

  const act = (id: string, action: "approve" | "reject") => {
    const operation = coordinator.capture(ws);
    const previous = memory?.candidates.find((candidate) => candidate.id === id);
    if (!memory || !operation || !previous) return;
    const optimisticStatus = action === "approve" ? "approved" : "rejected";
    // Optimistic update; roll back on failure.
    setMemory({
      ...memory,
      candidates: memory.candidates.map((candidate) =>
        candidate.id === id ? { ...candidate, status: optimisticStatus } : candidate,
      ),
    });
    api
      .memoryAction(id, action, action === "approve" ? scope : undefined, operation.workspaceId)
      .catch((e: unknown) => {
        if (!coordinator.isCurrent(operation)) return;
        setError(String(e));
        setMemory((current) =>
          current
            ? {
                ...current,
                candidates: current.candidates.map((candidate) =>
                  candidate.id === id && candidate.status === optimisticStatus ? previous : candidate,
                ),
              }
            : current,
        );
      });
  };

  const deleteFact = (fact: MemoryFact) => {
    const operation = coordinator.capture(ws);
    if (!operation) return;
    const workspaceId = operation.workspaceId;
    setMemory((current) =>
      current ? { ...current, facts: current.facts.filter((item) => !sameFact(item, fact)) } : current,
    );
    void enqueueDelete(async () => {
      if (!coordinator.isCurrent(operation)) return;
      const snapshot = serverMemoryRef.current;
      if (!snapshot || snapshot.workspaceId !== workspaceId) return;
      const currentFact = snapshot.value.facts.find((item) => sameFact(item, fact));
      if (!currentFact) return;
      try {
        // Content matching is stable across index renumbering, including
        // changes made by another client. Ambiguous duplicates fail closed.
        await api.memoryDeleteFact({ match: currentFact.content }, workspaceId);
      } catch (e) {
        if (coordinator.isCurrent(operation)) setError(String(e));
      }
      if (coordinator.isCurrent(operation)) await refresh(workspaceId);
    });
  };

  const addFact = (content: string, type: MemoryCandidateType): Promise<void> => {
    const operation = coordinator.capture(ws);
    if (!operation) return Promise.resolve();
    return api
      .memoryAddFact(content, type, undefined, scope, operation.workspaceId)
      .then(() => (coordinator.isCurrent(operation) ? refresh(operation.workspaceId) : undefined));
  };

  const fq = filter.trim().toLowerCase();
  const hit = (s: string) => fq === "" || s.toLowerCase().includes(fq);
  const pending = (memory?.candidates.filter((c) => c.status === "pending") ?? []).filter((c) => hit(c.content));
  const resolved = (memory?.candidates.filter((c) => c.status !== "pending") ?? []).filter((c) => hit(c.content));
  const facts = (memory?.facts ?? []).filter((f) => hit(f.content));
  // Empty state reflects the workspace, not the current filter.
  const isEmpty = memory !== null && memory.candidates.length === 0 && memory.facts.length === 0 && !memory.projectMd;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-primary">{t("memory.title")}</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tertiary">{t("memory.description")}</p>
          <div className="mt-2 max-w-xs">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("memory.filterPlaceholder")}
            />
          </div>
        </div>
        <div className="shrink-0">
          <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("memory.scopeLabel")}</div>
          <div className="flex items-center rounded-lg border border-subtle p-0.5">
            {[
              { value: "project" as const, label: t("memory.scopeProject") },
              { value: "user" as const, label: t("memory.scopeUser") },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setScope(opt.value)}
                title={opt.value === "user" ? t("memory.scopeUserHint") : t("memory.scopeProjectHint")}
                className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  scope === opt.value ? "bg-accent-muted text-accent" : "text-secondary hover:bg-accent-muted/60"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
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
                    <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("memory.resolvedSection")}</h2>
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

            {/* Side column: stats + compaction + approved facts + project.md */}
            <aside className="space-y-6 lg:col-span-1">
              <StatsPanel stats={stats} />

              <GovernancePanel report={governance} />

              <CompactControl
                key={ws}
                workspaceId={ws}
                maintenance={memory.maintenance}
                onApplied={() => refresh(ws)}
              />

              <KeywordControl key={`kw-${ws}`} workspaceId={ws} onApplied={() => refresh(ws)} />

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
                  <AddFactForm key={ws} onAdd={addFact} />
                </Card>
              </section>

              <section>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("memory.projectMdSection")}</h2>
                </div>
                {memory.projectMd ? (
                  <Card className="border-accent/30 bg-accent/[0.04] p-5">
                    <div className="mb-3 flex items-center gap-2 text-accent-hover">
                      <IconSparkle size={14} />
                      <span className="font-mono text-2xs uppercase tracking-wide">{t("memory.projectMdSection")}</span>
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
        <span className="font-mono text-2xs text-tertiary">{t("memory.confidence", { pct })}</span>
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
      {candidate.keywords && candidate.keywords.length > 0 && (
        // Approving the fact approves these too: they widen what it will be
        // retrieved by, so a reviewer has to be able to see them.
        <p className="mt-2 font-mono text-2xs text-tertiary" title={t("memory.keywords")}>
          {candidate.keywords.join(" · ")}
        </p>
      )}
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

function GovernancePanel({ report }: { report: MemoryGovernanceReport | null }) {
  const t = useT();
  if (!report) return null;
  const weakest = report.facts
    .slice()
    .sort((left, right) => left.qualityScore - right.qualityScore)
    .slice(0, 3);
  const factsByIndex = new Map(report.facts.map((fact) => [fact.index, fact]));
  const duplicatePairs = report.duplicateGroups
    .map((group) => group.map((index) => factsByIndex.get(index)).filter((fact) => fact !== undefined))
    .filter((group) => group.length > 1)
    .slice(0, 5);
  const conflicts = report.contradictionCandidates
    .map((candidate) => [factsByIndex.get(candidate.left), factsByIndex.get(candidate.right)] as const)
    .filter((pair) => pair[0] !== undefined && pair[1] !== undefined)
    .slice(0, 5);
  return (
    <section>
      <h2 className="mb-2 text-2xs uppercase tracking-wider text-tertiary">{t("memory.governanceTitle")}</h2>
      <Card className="space-y-2 p-4 text-xs text-secondary">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <strong className="block text-primary">{report.duplicateGroups.length}</strong>
            {t("memory.duplicates")}
          </div>
          <div>
            <strong className="block text-primary">{report.contradictionCandidates.length}</strong>
            {t("memory.conflicts")}
          </div>
          <div>
            <strong className="block text-primary">{report.retrieval.staleFacts}</strong>
            {t("memory.stale")}
          </div>
        </div>
        <p className="text-tertiary">
          {t("memory.retrievalEffectiveness", {
            exposure: (report.retrieval.exposureToUseRate * 100).toFixed(0),
            retrieval: (report.retrieval.retrievalToUseRate * 100).toFixed(0),
          })}
        </p>
        {weakest.length > 0 && (
          <details>
            <summary className="cursor-pointer">{t("memory.lowQuality")}</summary>
            <ul className="mt-2 space-y-1">
              {weakest.map((fact) => (
                <li key={fact.index} title={fact.content}>
                  <span className="block truncate">
                    {(fact.qualityScore * 100).toFixed(0)}% · {fact.content}
                  </span>
                  <span className="text-2xs text-tertiary">
                    {t("memory.qualityDetail", {
                      age: fact.ageDays.toFixed(0),
                      decay: (fact.decayScore * 100).toFixed(0),
                      uses: fact.uses,
                      source: fact.sourceSessionId ?? t("memory.unknownSource"),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {duplicatePairs.length > 0 && (
          <details>
            <summary className="cursor-pointer">{t("memory.duplicateDetails")}</summary>
            <ul className="mt-2 space-y-2">
              {duplicatePairs.map((group) => (
                <li key={group.map((fact) => fact!.index).join("-")} className="rounded bg-surface-overlay p-2">
                  {group.map((fact) => (
                    <p key={fact!.index} className="truncate" title={fact!.content}>
                      #{fact!.index} {fact!.content}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        )}
        {conflicts.length > 0 && (
          <details>
            <summary className="cursor-pointer">{t("memory.conflictDetails")}</summary>
            <ul className="mt-2 space-y-2">
              {conflicts.map(([left, right]) => (
                <li key={`${left!.index}-${right!.index}`} className="rounded bg-warn/10 p-2">
                  <p className="truncate" title={left!.content}>
                    #{left!.index} {left!.content}
                  </p>
                  <p className="truncate" title={right!.content}>
                    #{right!.index} {right!.content}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </section>
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

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** Read-only extraction-quality stats (counts + used fraction + rejection rate). */
function StatsPanel({ stats }: { stats: MemoryStats | null }) {
  const t = useT();
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("memory.stats.title")}</h2>
        <span className="h-px flex-1 border-t border-subtle" />
      </div>
      <Card className="p-4">
        {stats === null ? (
          <p className="text-xs text-tertiary">{t("memory.stats.loading")}</p>
        ) : (
          <dl className="space-y-2.5 text-xs">
            <StatRow label={t("memory.stats.approvedFacts")} value={String(stats.totalApprovedFacts)} />
            <StatRow label={t("memory.stats.autoExtracted")} value={String(stats.autoExtractedFacts)} />
            <StatRow label={t("memory.stats.directAdded")} value={String(stats.directAddedFacts)} />
            <StatRow label={t("memory.stats.usedFraction")} value={pct(stats.usedFraction)} />
            <StatRow label={t("memory.stats.rejectionRate")} value={pct(stats.rejectionRate)} />
            <p className="border-t border-subtle pt-2 font-mono text-2xs text-tertiary">
              {t("memory.stats.candidates", {
                pending: stats.pending,
                approved: stats.approved,
                rejected: stats.rejected,
              })}
            </p>
            <p className="font-mono text-2xs text-tertiary">
              {t("memory.stats.avgConfidence", {
                used: stats.avgConfidenceUsed === null ? t("memory.stats.na") : pct(stats.avgConfidenceUsed),
                unused: stats.avgConfidenceUnused === null ? t("memory.stats.na") : pct(stats.avgConfidenceUnused),
              })}
            </p>
          </dl>
        )}
      </Card>
    </section>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-tertiary">{label}</dt>
      <dd className="font-mono text-sm font-medium text-primary">{value}</dd>
    </div>
  );
}

/**
 * Backfill bilingual retrieval keywords onto the facts that have none.
 *
 * Keywords normally arrive with extraction, in the model call it was already
 * making — so a fact added by hand here has none, and neither does anything
 * remembered before the field existed. This is the only control in this view
 * that spends money, so it shows the count first and reports the cost after.
 */
function KeywordControl({ workspaceId, onApplied }: { workspaceId: string; onApplied: () => void }) {
  const t = useT();
  const [missing, setMissing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new LatestRequest()).current;

  useEffect(() => {
    const request = requests.begin();
    api
      .memoryKeywordsMissing(workspaceId)
      .then((r) => {
        if (requests.isCurrent(request)) setMissing(r.missing);
      })
      .catch(() => {
        if (requests.isCurrent(request)) setMissing(null);
      });
    return () => requests.invalidate();
  }, [requests, workspaceId]);

  const run = () => {
    const request = requests.begin();
    setBusy(true);
    setError(null);
    setNote(null);
    api
      .memoryBackfillKeywords({}, workspaceId)
      .then((r) => {
        if (!requests.isCurrent(request)) return;
        setMissing(Math.max(0, r.missing - r.updated));
        setNote(
          t("memory.keywords.done", {
            updated: r.updated,
            missing: r.missing,
            cost: r.usage.costUsd.toFixed(4),
          }),
        );
        onApplied();
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(String(cause));
      })
      .finally(() => {
        if (requests.isCurrent(request)) setBusy(false);
      });
  };

  // Nothing to do and nothing to explain: a workspace whose facts all carry
  // keywords should not grow a control that does nothing.
  if (missing === null || missing === 0) return null;

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("memory.keywords.title")}</h2>
        <span className="h-px flex-1 border-t border-subtle" />
      </div>
      <Card className="p-4">
        <p className="text-xs leading-relaxed text-tertiary">{t("memory.keywords.description", { count: missing })}</p>
        <Button variant="primary" size="sm" className="mt-3" onClick={run} disabled={busy}>
          {busy ? t("memory.keywords.running") : t("memory.keywords.runBtn")}
        </Button>
        {note && <p className="mt-2 text-2xs text-ok">{note}</p>}
        {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
      </Card>
    </section>
  );
}

/** Dry-run preview → apply compaction, with an optional prune-unused-days input. */
function CompactControl({
  workspaceId,
  maintenance,
  onApplied,
}: {
  workspaceId: string;
  maintenance: MemoryResponse["maintenance"];
  onApplied: () => void;
}) {
  const t = useT();
  const [pruneDays, setPruneDays] = useState("");
  const [preview, setPreview] = useState<{
    result: CompactResult;
    options: { pruneUnusedDays?: number };
  } | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new LatestRequest()).current;

  useEffect(() => {
    requests.invalidate();
    setPruneDays("");
    setPreview(null);
    setBusy(null);
    setNote(null);
    setError(null);
    return () => requests.invalidate();
  }, [requests, workspaceId]);

  const runPreview = () => {
    let options: { dryRun: boolean; pruneUnusedDays?: number };
    try {
      options = memoryCompactOptions(pruneDays, true);
    } catch (caught) {
      setError(t("memory.compact.error", { error: caught instanceof Error ? caught.message : String(caught) }));
      return;
    }
    const request = requests.begin();
    const requestWorkspace = workspaceId;
    setBusy("preview");
    setError(null);
    setNote(null);
    api
      .memoryCompact(options, requestWorkspace)
      .then((result) => {
        if (requests.isCurrent(request)) {
          setPreview({
            result,
            options: options.pruneUnusedDays === undefined ? {} : { pruneUnusedDays: options.pruneUnusedDays },
          });
        }
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(t("memory.compact.error", { error: String(cause) }));
      })
      .finally(() => {
        if (requests.isCurrent(request)) setBusy(null);
      });
  };

  const apply = () => {
    if (!preview) return;
    const request = requests.begin();
    const requestWorkspace = workspaceId;
    const options = { dryRun: false, ...preview.options };
    setBusy("apply");
    setError(null);
    api
      .memoryCompact(options, requestWorkspace)
      .then((r) => {
        if (!requests.isCurrent(request)) return;
        setPreview(null);
        setNote(t("memory.compact.done", { before: r.before, after: r.after }));
        onApplied();
      })
      .catch((cause: unknown) => {
        if (requests.isCurrent(request)) setError(t("memory.compact.error", { error: String(cause) }));
      })
      .finally(() => {
        if (requests.isCurrent(request)) setBusy(null);
      });
  };

  const hasChanges =
    preview !== null &&
    (preview.result.removed.length > 0 || preview.result.merged.length > 0 || preview.result.archived.length > 0);

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-2xs uppercase tracking-wider text-tertiary">{t("memory.compact.title")}</h2>
        <span className="h-px flex-1 border-t border-subtle" />
      </div>
      <Card className="p-4">
        <p className="text-xs leading-relaxed text-tertiary">{t("memory.compact.description")}</p>
        {maintenance && (
          <p className="mt-2 rounded-md bg-surface-overlay px-2 py-1.5 font-mono text-2xs text-tertiary">
            {t("memory.compact.lastAutomatic", {
              age: relativeAge(t, maintenance.lastRunAt),
              before: maintenance.lastResult.before,
              after: maintenance.lastResult.after,
              archived: maintenance.lastResult.archived,
            })}
          </p>
        )}
        <label htmlFor="memory-prune-days" className="mt-3 block text-2xs uppercase tracking-wider text-tertiary">
          {t("memory.compact.pruneLabel")}
        </label>
        <Input
          id="memory-prune-days"
          value={pruneDays}
          onChange={(e) => {
            setPruneDays(e.target.value);
            setPreview(null);
            setNote(null);
            setError(null);
          }}
          inputMode="numeric"
          placeholder={t("memory.compact.prunePlaceholder")}
          className="mt-1.5"
          disabled={busy !== null}
        />

        {preview === null ? (
          <Button variant="primary" size="sm" className="mt-3" onClick={runPreview} disabled={busy !== null}>
            {busy === "preview" ? t("memory.compact.previewing") : t("memory.compact.previewBtn")}
          </Button>
        ) : (
          <div className="mt-3 space-y-2 border-t border-subtle pt-3 text-xs">
            <p className="font-mono text-sm text-primary">
              {t("memory.compact.summary", { before: preview.result.before, after: preview.result.after })}
            </p>
            {!hasChanges && <p className="text-tertiary">{t("memory.compact.noChanges")}</p>}
            <CompactList title={t("memory.compact.removed")} items={preview.result.removed} tone="text-danger" />
            <CompactList
              title={t("memory.compact.merged")}
              items={preview.result.merged.map((m) => m.dropped)}
              tone="text-warn"
            />
            <CompactList title={t("memory.compact.archived")} items={preview.result.archived} tone="text-tertiary" />
            <div className="flex gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={apply} disabled={busy !== null || !hasChanges}>
                {busy === "apply" ? t("memory.compact.applying") : t("memory.compact.applyBtn")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)} disabled={busy !== null}>
                {t("memory.compact.cancelBtn")}
              </Button>
            </div>
          </div>
        )}
        {note && <p className="mt-2 text-2xs text-ok">{note}</p>}
        {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
      </Card>
    </section>
  );
}

function CompactList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{title}</div>
      <ul className={`space-y-0.5 font-mono text-2xs ${tone}`}>
        {items.map((it, i) => (
          <li key={`${it}-${i}`} className="break-words">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddFactForm({ onAdd }: { onAdd: (content: string, type: MemoryCandidateType) => Promise<void> }) {
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
        <Select
          value={type}
          onChange={(v) => setType(v as MemoryCandidateType)}
          disabled={busy}
          size="sm"
          options={FACT_TYPES.map((ft) => ({ value: ft, label: ft }))}
          className="w-36"
        />
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
