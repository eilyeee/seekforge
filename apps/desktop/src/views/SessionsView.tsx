import { useEffect, useState } from "react";
import type { ChatMessage, SessionStatus } from "@seekforge/shared";
import { ApiError, api } from "../lib/api";
import { messagesToItems } from "../lib/messages";
import { filterSessions } from "../lib/sessions-filter";
import { formatUsd } from "../lib/usage";
import { useStore } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Markdown } from "../components/Markdown";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconChat, IconChevron, IconSessions, Input, Modal, type BadgeTone } from "../components/ui";
import type { PruneResult, RewindResult, SessionMeta } from "../types";

/** Short, human time for a card corner: today → "10:24", else a compact date. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  idle: "neutral",
  running: "warn",
  waiting_approval: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "neutral",
};

type Detail = { meta: SessionMeta; messages: ChatMessage[] };

export function SessionsView() {
  const t = useT();
  const continueSession = useStore((s) => s.continueSession);
  const ws = useStore((s) => s.activeWorkspaceId);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Client-side search over id and task text. */
  const [query, setQuery] = useState("");
  /** Dry-run result awaiting confirmation. */
  const [rewindPreview, setRewindPreview] = useState<{ sessionId: string; result: RewindResult } | null>(null);
  /** Per-session inline note ("no checkpoints" / result summary). */
  const [rewindNotes, setRewindNotes] = useState<Record<string, string>>({});
  /** Pending per-row delete confirmation. */
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null);
  /** Open "Prune old…" panel. */
  const [pruneOpen, setPruneOpen] = useState(false);
  /**
   * Read-only audit modal. `markdown === null && !error` = loading; `error`
   * holds a formatted failure message (404 → a short "no audit" note).
   */
  const [audit, setAudit] = useState<{ sessionId: string; markdown: string | null; error: string | null } | null>(null);

  const refresh = () =>
    api
      .sessions()
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));

  useEffect(() => {
    setSessions(null);
    setDetail(null);
    setError(null);
    setRewindNotes({});
    setPendingDelete(null);
    setPruneOpen(false);
    setAudit(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    api
      .sessionDelete(id)
      .then(refresh)
      .catch((e: unknown) => setError(t("sessions.deleteError", { error: String(e) })));
  };

  /** Read-only preview of the transcript (the "View details" action). */
  const openSession = (id: string) => {
    setError(null);
    api
      .session(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)));
  };

  /**
   * Resume into a live chat: loads the full transcript into a new chat tab bound
   * to this session, so the user can keep asking questions (not a dead preview).
   */
  const doContinue = (id: string) => {
    setError(null);
    api
      .session(id)
      .then(({ meta, messages }) => continueSession(meta, messages))
      .catch((e: unknown) => setError(String(e)));
  };

  const noteFor = (id: string, e: unknown): string =>
    e instanceof ApiError && e.status === 404 ? t("sessions.rewindNoCheckpoints") : String(e);

  const startRewind = (id: string) => {
    setRewindNotes((n) => ({ ...n, [id]: "" }));
    api
      .rewind(id, true)
      .then((result) => setRewindPreview({ sessionId: id, result }))
      .catch((e: unknown) => setRewindNotes((n) => ({ ...n, [id]: noteFor(id, e) })));
  };

  const confirmRewind = () => {
    if (!rewindPreview) return;
    const { sessionId } = rewindPreview;
    setRewindPreview(null);
    api
      .rewind(sessionId)
      .then((r) =>
        setRewindNotes((n) => ({
          ...n,
          [sessionId]: t("sessions.rewindResult", { restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length }),
        })),
      )
      .catch((e: unknown) => setRewindNotes((n) => ({ ...n, [sessionId]: noteFor(sessionId, e) })));
  };

  /** Fetch and show the read-only per-turn audit for a session in a modal. */
  const openAudit = (id: string) => {
    setAudit({ sessionId: id, markdown: null, error: null });
    api
      .sessionAudit(id)
      .then(({ markdown }) =>
        setAudit((a) => (a && a.sessionId === id ? { ...a, markdown } : a)),
      )
      .catch((e: unknown) => {
        const msg =
          e instanceof ApiError && e.status === 404
            ? t("sessions.auditNotFound")
            : t("sessions.auditError", { error: String(e) });
        setAudit((a) => (a && a.sessionId === id ? { ...a, error: msg } : a));
      });
  };

  if (detail) {
    return (
      <div className="flex h-full flex-col bg-surface">
        <header className="flex items-center gap-3 border-b border-subtle px-6 py-3">
          <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
            {t("sessions.backBtn")}
          </Button>
          <span className="font-mono text-xs text-tertiary">{detail.meta.id}</span>
          <Badge tone={STATUS_TONE[detail.meta.status]}>{detail.meta.status}</Badge>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => continueSession(detail.meta, detail.messages)}
          >
            {t("sessions.continueBtn")}
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <ChatItems items={messagesToItems(detail.messages)} />
        </div>
      </div>
    );
  }

  const visible = filterSessions(sessions ?? [], query);

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="border-b border-subtle px-6 py-4">
        <h1 className="text-lg font-semibold text-primary">{t("sessions.title")}</h1>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sessions.searchPlaceholder")}
            className="max-w-md flex-1"
          />
          <Button variant="ghost" size="md" className="shrink-0">
            <IconSessions size={15} />
          </Button>
          <Button
            size="md"
            className="shrink-0"
            onClick={() => setPruneOpen(true)}
            disabled={!sessions || sessions.length === 0}
          >
            {t("sessions.pruneBtn")}
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>
        )}
        {sessions === null ? (
          !error && <p className="text-tertiary">{t("sessions.loading")}</p>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={<IconSessions size={28} />}
            title={t("sessions.emptyTitle")}
            description={t("sessions.emptyDescription")}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconSessions size={28} />}
            title={t("sessions.noMatchTitle")}
            description={t("sessions.noMatchDescription", { query: query.trim() })}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((s) => (
              <li key={s.id}>
                <Card
                  onClick={() => doContinue(s.id)}
                  className="group cursor-pointer p-5 transition-colors hover:border-strong hover:bg-surface-overlay"
                >
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                      <IconChat size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{s.task}</h2>
                        <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="truncate font-mono text-2xs text-tertiary">{s.id}</span>
                        {rewindNotes[s.id] && (
                          <span className="font-mono text-2xs text-warn">{rewindNotes[s.id]}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-3">
                        {s.usage && (
                          <span className="font-mono text-xs text-secondary">{formatUsd(s.usage.costUsd)}</span>
                        )}
                        <span className="text-2xs text-tertiary">{formatWhen(s.updatedAt)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {s.status !== "running" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRewind(s.id);
                            }}
                            title={t("sessions.rewindBtnTitle")}
                          >
                            {t("sessions.rewindBtn")}
                          </Button>
                        )}
                        {s.status !== "running" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-tertiary hover:text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(s);
                            }}
                          >
                            {t("sessions.deleteBtn")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAudit(s.id);
                          }}
                          title={t("sessions.auditBtnTitle")}
                        >
                          {t("sessions.auditBtn")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSession(s.id);
                          }}
                        >
                          {t("sessions.viewDetailsBtn")}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            doContinue(s.id);
                          }}
                        >
                          {t("sessions.continueBtn")}
                          <IconChevron size={14} />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rewindPreview && (
        <ConfirmDialog
          title={t("sessions.rewindTitle", { sessionId: rewindPreview.sessionId })}
          confirmLabel={t("sessions.rewindConfirm")}
          danger
          onConfirm={confirmRewind}
          onCancel={() => setRewindPreview(null)}
        >
          <div className="space-y-2 text-xs">
            {rewindPreview.result.restored.length === 0 && rewindPreview.result.deleted.length === 0 ? (
              <p>{t("sessions.rewindBodyNone")}</p>
            ) : (
              <>
                {rewindPreview.result.restored.length > 0 && (
                  <div>
                    <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("sessions.rewindSectionRestore")}</div>
                    <ul className="space-y-0.5 font-mono text-accent">
                      {rewindPreview.result.restored.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {rewindPreview.result.deleted.length > 0 && (
                  <div>
                    <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("sessions.rewindSectionDelete")}</div>
                    <ul className="space-y-0.5 font-mono text-danger">
                      {rewindPreview.result.deleted.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {rewindPreview.result.skipped.length > 0 && (
              <p className="text-tertiary">{t("sessions.rewindSkipped", { count: rewindPreview.result.skipped.length })}</p>
            )}
          </div>
        </ConfirmDialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("sessions.deleteTitle")}
          confirmLabel={t("sessions.deleteConfirm")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        >
          {t("sessions.deleteBody")}
        </ConfirmDialog>
      )}

      {pruneOpen && (
        <PruneDialog
          onClose={() => setPruneOpen(false)}
          onApplied={() => {
            setPruneOpen(false);
            void refresh();
          }}
        />
      )}

      {audit && (
        <Modal
          title={t("sessions.auditTitle", { sessionId: audit.sessionId })}
          wide
          onDismiss={() => setAudit(null)}
          footer={<Button onClick={() => setAudit(null)}>{t("sessions.auditCloseBtn")}</Button>}
        >
          {audit.error ? (
            <p className="text-xs text-danger">{audit.error}</p>
          ) : audit.markdown === null ? (
            <p className="text-xs text-tertiary">{t("sessions.auditLoading")}</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed text-secondary">
              <Markdown source={audit.markdown} />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** "Prune old sessions": olderThanDays / keepLast inputs, dry-run preview, apply. */
function PruneDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const t = useT();
  const [olderThanDays, setOlderThanDays] = useState("");
  const [keepLast, setKeepLast] = useState("");
  const [preview, setPreview] = useState<PruneResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const optsOf = (dryRun: boolean) => {
    const days = olderThanDays.trim();
    const keep = keepLast.trim();
    return {
      dryRun,
      ...(days !== "" ? { olderThanDays: Number(days) } : {}),
      ...(keep !== "" ? { keepLast: Number(keep) } : {}),
    };
  };

  const runPreview = () => {
    setBusy("preview");
    setError(null);
    setNote(null);
    api
      .sessionsPrune(optsOf(true))
      .then(setPreview)
      .catch((e: unknown) => setError(t("sessions.pruneError", { error: String(e) })))
      .finally(() => setBusy(null));
  };

  const apply = () => {
    setBusy("apply");
    setError(null);
    api
      .sessionsPrune(optsOf(false))
      .then((r) => {
        setNote(t("sessions.pruneDone", { count: r.removed.length }));
        onApplied();
      })
      .catch((e: unknown) => setError(t("sessions.pruneError", { error: String(e) })))
      .finally(() => setBusy(null));
  };

  const hasPreview = preview !== null;
  const willPrune = preview ? preview.removed.length : 0;

  return (
    <ConfirmDialog
      title={t("sessions.pruneTitle")}
      confirmLabel={
        !hasPreview
          ? busy === "preview"
            ? t("sessions.prunePreviewing")
            : t("sessions.prunePreviewBtn")
          : busy === "apply"
            ? t("sessions.pruneApplying")
            : t("sessions.pruneApplyBtn", { count: willPrune })
      }
      danger={hasPreview && willPrune > 0}
      onConfirm={!hasPreview ? runPreview : apply}
      onCancel={onClose}
    >
      <div className="space-y-3 text-xs">
        <label className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("sessions.pruneOlderThan")}</span>
          <Input
            value={olderThanDays}
            onChange={(e) => {
              setOlderThanDays(e.target.value.replace(/[^0-9]/g, ""));
              setPreview(null);
            }}
            inputMode="numeric"
            placeholder={t("sessions.pruneOlderThanPlaceholder")}
            className="mt-1"
            disabled={busy !== null}
          />
        </label>
        <label className="block">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("sessions.pruneKeepLast")}</span>
          <Input
            value={keepLast}
            onChange={(e) => {
              setKeepLast(e.target.value.replace(/[^0-9]/g, ""));
              setPreview(null);
            }}
            inputMode="numeric"
            placeholder={t("sessions.pruneKeepLastPlaceholder")}
            className="mt-1"
            disabled={busy !== null}
          />
        </label>
        {hasPreview &&
          (willPrune > 0 ? (
            <p className="text-secondary">
              {t("sessions.prunePreview", { count: willPrune, kept: preview!.kept })}
            </p>
          ) : (
            <p className="text-tertiary">{t("sessions.pruneNone")}</p>
          ))}
        {note && <p className="text-ok">{note}</p>}
        {error && <p className="text-danger">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}
